/**
 * Entry for the `<script>` tag build.
 *
 * Deliberately exports nothing. Vite's library mode assigns an IIFE's module
 * namespace to the configured global, which would overwrite the `window.WebAI`
 * instance that `index.ts` installs and leave the public API unreachable. A
 * side-effect-only entry has no namespace to assign, so the instance survives.
 *
 * npm consumers get `index.ts` instead, which keeps its named exports.
 */
import './index.js';
