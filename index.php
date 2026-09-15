<?php
/* The app lives under /client; hitting the site root sends you to the board.
   302 rather than 301 so the redirect can be changed later without fighting
   browser caches. Resolved relative to this script so the app still works when
   the project is served from a subdirectory rather than a domain root. */
$base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'])), '/');
header('Location: ' . $base . '/client/board.html', true, 302);
exit;
