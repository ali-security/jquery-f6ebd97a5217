"use strict";

var assert = require( "assert" );

require( "jsdom" ).env( "", function( errors, window ) {
	assert.ifError( errors );

	var ensureJQuery = require( "./lib/ensure_jquery" ),
		ensureGlobalNotCreated = require( "./lib/ensure_global_not_created" ),
		jQuery = require( "../../dist/jquery.js" )( window ),
		payloads = [
			"<div/><span/>",
			"<style><style/><img id='xss'>",
			"<img alt=\"<x\" title=\"/><img id='xss'>\">"
		];

	ensureJQuery( jQuery );

	// jQuery.htmlPrefilter must not rewrite self-closing tags: the rewrite
	// could turn sanitized HTML into executable markup (CVE-2020-11022).
	payloads.forEach( function( html ) {
		assert.strictEqual( jQuery.htmlPrefilter( html ), html,
			"jQuery.htmlPrefilter modified the input: " + html );
	} );

	// The <img> stays inside the raw text of the <style> element.
	assert.strictEqual(
		jQuery( "<div></div>" ).html( payloads[ 1 ] ).find( "img" ).length, 0,
		"A self-closed <style/> must not close the outer <style> element" );

	ensureGlobalNotCreated( module.exports );
} );
