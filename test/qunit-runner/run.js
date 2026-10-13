/*
 * Headless runner for the jQuery QUnit browser suite (test/index.html).
 *
 * Opens test/index.html?dev&hidepassed (the whole suite against the unminified
 * dist/jquery.js) in headless Chrome, hooks QUnit's moduleStart/testStart/
 * log/testDone/done callbacks in the TOP frame only, prints one line per test,
 * a per-module table and a final summary, and exits non-zero if any test
 * failed, no test ran, or the suite never reported done().
 *
 * Requires: Node >= 18, puppeteer-core resolvable via NODE_PATH (installed
 * outside the repo; not a jQuery dependency), a Chrome binary, and the repo
 * root served over HTTP with PHP (e.g. `php -S 127.0.0.1:8000 -t .`).
 *
 * Environment:
 *   BASE_URL       default http://127.0.0.1:8000
 *   CHROME_BIN     default: first of google-chrome-stable / google-chrome /
 *                  chromium-browser / chromium on PATH
 *   QUNIT_TIMEOUT  overall timeout in ms (default 1500000 = 25 minutes)
 *   QUNIT_FILTER   optional extra query string appended to the page URL
 *                  (e.g. "module=ajax")
 */
"use strict";

var execSync = require( "child_process" ).execSync;
var puppeteer = require( "puppeteer-core" );

var BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8000";
var TIMEOUT = parseInt( process.env.QUNIT_TIMEOUT || "1500000", 10 );

// The offset module's setup scrolls to (1,1) and then detaches its 2000px
// spacer, relying on the page not being scrollable afterwards so it snaps back
// to (0,0) (the gh-2310 "hidden elements return zeros" assertion depends on
// it). So the QUnit results list must not make the page taller than the
// viewport: load with `hidepassed` (passed tests are removed from the DOM; our
// reporting uses QUnit callbacks, not the DOM) and use a tall viewport
// (VIEWPORT, applied in main()).
var VIEWPORT = { width: 1280, height: 2000 };
var PAGE_URL = BASE_URL + "/test/index.html?dev&hidepassed" +
	( process.env.QUNIT_FILTER ? "&" + process.env.QUNIT_FILTER : "" );
var MARKER = "__SEAL_QUNIT__";

// Environment-dependent tests that cannot pass in modern headless Chrome.
// They are excluded at declaration time (never registered with QUnit), so
// test/unit/*.js stays untouched. Keys are exact "module: test name" strings.
var SKIP_TESTS = [
	{
		test: "ajax: #14379 - jQuery.ajax() on unload",
		reason: "The test fires a synchronous XHR from a window unload handler; " +
			"Chrome 80+ forbids sync XHR during page dismissal so the request never " +
			"reaches the server (browser policy, not jQuery behaviour)."
	},
	{
		test: "offset: fractions (see #7730 and #7885)",
		reason: "The test asserts a fractional offset round-trips exactly; Blink snaps " +
			"layout to 1/64 px and reads back 999.984375 for 1000 (rendering-engine " +
			"precision, not jQuery behaviour)."
	}
];

// test/data/core/dont_return.php exists only to be a request that never
// completes (it sleep(30)s). On `php -S` that ties up a server worker; emulate
// the fixture's intent in the browser instead by pausing exactly these requests
// via the CDP Fetch domain and never answering them.
var NEVER_RETURNING = [ "*/test/data/core/dont_return.php*" ];

function findChrome() {
	if ( process.env.CHROME_BIN ) {
		return process.env.CHROME_BIN;
	}
	var names = [ "google-chrome-stable", "google-chrome", "chromium-browser", "chromium" ];
	for ( var i = 0; i < names.length; i++ ) {
		try {
			var p = execSync( "which " + names[ i ], { stdio: [ "ignore", "pipe", "ignore" ] } )
				.toString().trim();
			if ( p ) {
				return p;
			}
		} catch ( e ) {}
	}
	throw new Error( "No Chrome binary found; set CHROME_BIN" );
}

// Runs in every frame before any script. Only the top frame is instrumented:
// the suite spawns many iframes, and they must not register reporters.
function pageHook( marker, skipKeys ) {
	if ( window !== window.top ) {
		return;
	}

	// Snapshot natives: the ajax "Using Native JSON" test replaces window.JSON
	// with a parse-only stub, and tests may stub console. A reporter that called
	// the live JSON.stringify inside QUnit.log would throw and wedge the suite.
	var nativeStringify = JSON.stringify.bind( JSON );
	var nativeLog = console.log.bind( console );
	var skipSet = {};
	var i;
	for ( i = 0; i < skipKeys.length; i++ ) {
		skipSet[ skipKeys[ i ] ] = true;
	}

	function emit( obj ) {
		try {
			nativeLog( marker + nativeStringify( obj ) );
		} catch ( e ) {
			try {
				nativeLog( marker + "{\"type\":\"emitError\",\"message\":\"" +
					String( e && e.message || e ).replace( /["\\\n\r]/g, " " ) + "\"}" );
			} catch ( e2 ) {}
		}
	}

	function clip( s ) {
		s = String( s );
		return s.length > 2000 ? s.slice( 0, 2000 ) + "...[truncated]" : s;
	}

	function wrapDeclaration( owner, key, Q ) {
		var orig = owner[ key ];
		if ( typeof orig !== "function" || orig.__sealWrapped ) {
			return;
		}
		var wrapped = function( testName ) {
			var mod = "";
			try {
				mod = Q.config.currentModule && Q.config.currentModule.name || "";
			} catch ( e ) {}
			var full = mod + ": " + testName;
			if ( skipSet[ full ] ) {
				emit( { type: "skipped", test: full } );
				return;
			}
			return orig.apply( this, arguments );
		};
		wrapped.__sealWrapped = true;
		owner[ key ] = wrapped;
	}

	var hooked = false;
	var failures = [];

	function hook( Q ) {
		if ( hooked || !Q || typeof Q.log !== "function" ) {
			return;
		}
		hooked = true;

		Q.config.reorder = false;

		// qunit.js assigns window.QUnit after QUnit.test/asyncTest and the
		// window.test/window.asyncTest globals exist, so wrapping here catches
		// every declaration (testinit.js helpers call QUnit.test at call time;
		// QUnit.asyncTest delegates to QUnit.test).
		wrapDeclaration( Q, "test", Q );
		wrapDeclaration( Q, "asyncTest", Q );
		wrapDeclaration( window, "test", Q );
		wrapDeclaration( window, "asyncTest", Q );

		Q.moduleStart( function( d ) {
			emit( { type: "moduleStart", module: d.name } );
		} );
		Q.testStart( function( d ) {
			failures = [];
			emit( { type: "testStart", module: d.module, name: d.name } );
		} );
		Q.log( function( d ) {
			try {
				if ( d.result ) {
					return;
				}
				var f = { message: clip( d.message || "(no message)" ) };
				var fmt = function( v ) {
					try {
						return clip( Q.dump.parse( v ) );
					} catch ( e ) {
						return clip( String( v ) );
					}
				};
				if ( "expected" in d ) {
					f.expected = fmt( d.expected );
				}
				if ( "actual" in d ) {
					f.actual = fmt( d.actual );
				}
				if ( d.source ) {
					f.source = clip( String( d.source ).split( "\n" ).slice( 0, 3 ).join( " | " ) );
				}
				failures.push( f );
			} catch ( e ) {}
		} );
		Q.testDone( function( d ) {
			emit( {
				type: "testDone", module: d.module, name: d.name,
				failed: d.failed, passed: d.passed, total: d.total,
				failures: failures
			} );
			failures = [];
		} );
		Q.done( function( d ) {
			emit( { type: "done", failed: d.failed, passed: d.passed, total: d.total,
				runtime: d.runtime } );
		} );
	}

	var value;
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		get: function() {
			return value;
		},
		set: function( v ) {
			value = v;
			try {
				hook( v );
			} catch ( e ) {
				emit( { type: "emitError", message: "hook failed: " + String( e && e.message || e ) } );
			}
		}
	} );
}

function pad( s, n ) {
	s = String( s );
	while ( s.length < n ) {
		s += " ";
	}
	return s;
}

async function main() {
	var chrome = findChrome();
	var skipReasons = {};
	SKIP_TESTS.forEach( function( s ) {
		skipReasons[ s.test ] = s.reason;
	} );

	console.log( "QUnit runner: chrome=" + chrome + " url=" + PAGE_URL +
		" timeout=" + TIMEOUT + "ms" );

	var browser = await puppeteer.launch( {
		executablePath: chrome,
		headless: "new",
		args: [ "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,1024" ]
	} );
	console.log( "Browser: " + ( await browser.version() ) );

	var tests = [];
	var skipped = [];
	var pageErrors = [];
	var current = null;
	var doneInfo = null;
	var resolveDone;
	var donePromise = new Promise( function( resolve ) {
		resolveDone = resolve;
	} );

	var page = await browser.newPage();
	page.on( "pageerror", function( err ) {
		pageErrors.push( {
			message: String( err && err.message || err ),
			test: current
		} );
	} );
	page.on( "dialog", function( dialog ) {
		dialog.dismiss().catch( function() {} );
	} );
	page.on( "error", function( err ) {
		console.log( "Page crashed: " + ( err && err.message || err ) );
		resolveDone( "crash" );
	} );
	page.on( "console", function( msg ) {
		var text = msg.text();
		if ( text.indexOf( MARKER ) !== 0 ) {
			return;
		}
		var ev;
		try {
			ev = JSON.parse( text.slice( MARKER.length ) );
		} catch ( e ) {
			console.log( "Unparseable runner event: " + text.slice( 0, 300 ) );
			return;
		}
		if ( ev.type === "testStart" ) {
			current = ev.module + ": " + ev.name;
		} else if ( ev.type === "testDone" ) {
			current = null;
			tests.push( ev );
			var label = ev.module + ": " + ev.name + " (" + ev.total + " assertions)";
			if ( ev.failed > 0 ) {
				console.log( "FAIL " + label + " - " + ev.failed + " failed" );
				( ev.failures || [] ).forEach( function( f ) {
					console.log( "    - " + f.message );
					if ( f.expected !== undefined || f.actual !== undefined ) {
						console.log( "        expected: " + f.expected );
						console.log( "        actual:   " + f.actual );
					}
					if ( f.source ) {
						console.log( "        source: " + f.source );
					}
				} );
			} else {
				console.log( "PASS " + label );
			}
		} else if ( ev.type === "skipped" ) {
			skipped.push( ev.test );
			console.log( "SKIPPED " + ev.test + " — " + ( skipReasons[ ev.test ] || "" ) );
		} else if ( ev.type === "done" ) {
			if ( !doneInfo ) {
				doneInfo = ev;
				resolveDone( "done" );
			}
		} else if ( ev.type === "emitError" ) {
			console.log( "Runner emit error: " + ev.message );
		}
	} );

	await page.setViewport( VIEWPORT );
	var cdp = await page.target().createCDPSession();
	cdp.on( "Fetch.requestPaused", function() {} );
	await cdp.send( "Fetch.enable", {
		patterns: NEVER_RETURNING.map( function( p ) {
			return { urlPattern: p, requestStage: "Request" };
		} )
	} );
	await page.evaluateOnNewDocument( pageHook, MARKER, SKIP_TESTS.map( function( s ) {
		return s.test;
	} ) );

	var timer;
	var timeoutPromise = new Promise( function( resolve ) {
		timer = setTimeout( function() {
			resolve( "timeout" );
		}, TIMEOUT );
	} );

	var outcome;
	try {
		await page.goto( PAGE_URL, { waitUntil: "domcontentloaded", timeout: 120000 } );
		outcome = await Promise.race( [ donePromise, timeoutPromise ] );
	} catch ( e ) {
		outcome = "error: " + ( e && e.message || e );
	}
	clearTimeout( timer );

	await browser.close().catch( function() {} );

	// Per-module table
	var modules = [];
	var byModule = {};
	tests.forEach( function( t ) {
		var m = byModule[ t.module ];
		if ( !m ) {
			m = byModule[ t.module ] = { name: t.module, tests: 0, passed: 0, failed: 0,
				assertions: 0, assertFailed: 0 };
			modules.push( m );
		}
		m.tests++;
		m.assertions += t.total;
		m.assertFailed += t.failed;
		if ( t.failed > 0 ) {
			m.failed++;
		} else {
			m.passed++;
		}
	} );
	console.log( "" );
	console.log( "===== QUnit per-module summary =====" );
	console.log( pad( "module", 16 ) + pad( "tests", 8 ) + pad( "passed", 8 ) +
		pad( "failed", 8 ) + "assertions(failed)" );
	modules.forEach( function( m ) {
		console.log( pad( m.name, 16 ) + pad( m.tests, 8 ) + pad( m.passed, 8 ) +
			pad( m.failed, 8 ) + m.assertions + "(" + m.assertFailed + ")" +
			( m.failed ? "  <-- FAIL" : "" ) );
	} );

	var failedTests = tests.filter( function( t ) {
		return t.failed > 0;
	} );
	var assertions = tests.reduce( function( a, t ) {
		return a + t.total;
	}, 0 );

	SKIP_TESTS.forEach( function( s ) {
		if ( skipped.indexOf( s.test ) === -1 ) {
			console.log( "WARNING: SKIP_TESTS entry never matched a declared test: " + s.test );
		}
	} );
	if ( pageErrors.length ) {
		console.log( "Uncaught page errors (" + pageErrors.length + ") — expected; thrown on " +
			"purpose by the tests named below (e.g. test/data/badjson.js is intentionally " +
			"invalid script for the ajax script-error tests):" );
		pageErrors.slice( 0, 20 ).forEach( function( e ) {
			var where = e.test || "(between tests)";
			var results = e.test ? tests.filter( function( t ) {
				return t.module + ": " + t.name === e.test;
			} ) : [];
			var passed = results.length > 0 && results.every( function( t ) {
				return t.failed === 0;
			} );
			console.log( "    " + e.message + "  [raised during \"" + where + "\"" +
				( passed ? ", which passed — the suite deliberately throws this to test " +
					"error propagation" : "" ) + "]" );
		} );
	}

	if ( skipped.length ) {
		console.log( "Skipped tests (" + skipped.length + ") — environment-dependent, " +
			"excluded via SKIP_TESTS in test/qunit-runner/run.js:" );
		skipped.forEach( function( name ) {
			console.log( "    " + name + " — " + ( skipReasons[ name ] || "(no reason recorded)" ) );
		} );
	}

	console.log( "QUnit summary: total=" + tests.length + " passed=" +
		( tests.length - failedTests.length ) + " failed=" + failedTests.length +
		" assertions=" + assertions + " skipped=" + skipped.length +
		( doneInfo ? " qunitDone(failed=" + doneInfo.failed + ",total=" + doneInfo.total +
			",runtime=" + doneInfo.runtime + "ms)" : "" ) );
	console.log( "QUnit result: " + ( tests.length - failedTests.length ) + " tests passed, " +
		failedTests.length + " failed, " + skipped.length + " skipped (" +
		assertions + " assertions)" );

	var ok = true;
	if ( outcome !== "done" ) {
		console.log( "ERROR: suite did not finish (" + outcome + ")" +
			( current ? "; test in progress: " + current : "" ) );
		ok = false;
	}
	if ( tests.length === 0 ) {
		console.log( "ERROR: no tests ran" );
		ok = false;
	}
	if ( failedTests.length > 0 || ( doneInfo && doneInfo.failed > 0 ) ) {
		console.log( "ERROR: failing tests:" );
		failedTests.forEach( function( t ) {
			console.log( "    " + t.module + ": " + t.name );
		} );
		ok = false;
	}
	return ok ? 0 : 1;
}

main().then( function( code ) {
	process.exit( code );
}, function( err ) {
	console.error( "QUnit runner crashed: " + ( err && err.stack || err ) );
	process.exit( 1 );
} );
