<?php
/*
 * Frigate Battle Map — shared state server.
 *
 * GET  board.php?get       -> full board state (JSON)
 * GET  board.php?pieces    -> autoscanned list from pieces/images/*.png
 * POST board.php           -> one JSON action: resize | create | move | counter | ping
 *
 * The board state lives in board-state.json. Writes are serialised with flock
 * and saved atomically (temp file + rename) so the state can never be half-written.
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

define('STATE_FILE', __DIR__ . '/board-state.json');
define('IMAGES_DIR', __DIR__ . '/pieces/images');
define('BOARD_VERSION', 7);   // bump when behaviour changes; returned as "v" in every response so we can verify the live file
define('MAX_SIZE', 40);
define('PING_TTL', 4);

$VALID_ACTIONS = array('resize', 'create', 'move', 'counter', 'exhaust', 'ping');
$VALID_COLORS  = array('red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink');
$PACKET_LIMIT  = 65536;

function respond($data) {
    $data['v'] = BOARD_VERSION;
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function defaultState() {
    return array('rev' => 0, 'grid' => array('size' => 18), 'pieces' => array(), 'chips' => array(), 'pings' => array());
}

function normalize(&$s) {
    if (!is_array($s) || !isset($s['grid']) || !is_array($s['grid'])) {
        $s = defaultState();
        return;
    }
    foreach (array('pieces', 'chips', 'pings') as $k) {
        if (!isset($s[$k]) || !is_array($s[$k])) $s[$k] = array();
    }
    if (!isset($s['rev']) || !is_numeric($s['rev'])) $s['rev'] = 0;
    $s['rev'] = (int)$s['rev'];
    $s['grid']['size'] = max(1, min(MAX_SIZE, (int)$s['grid']['size']));
    $now = time();
    $kept = array();
    foreach ($s['pings'] as $p) {
        if ($now - (int)$p['t'] <= PING_TTL) $kept[] = $p;
    }
    $s['pings'] = $kept;
}

function readStateFile() {
    $txt = @file_get_contents(STATE_FILE);
    $s = null;
    if ($txt !== false) $s = json_decode($txt, true);
    normalize($s);
    return $s;
}

function mutateState($mutator) {
    // Lock via a dedicated .lock file so a failed action never creates/truncates board-state.json.
    $lk = @fopen(STATE_FILE . '.lock', 'c+');
    if (!$lk) return array('error' => 'storage unavailable');
    if (!flock($lk, LOCK_EX)) { @fclose($lk); return array('error' => 'storage busy'); }

    clearstatcache(true, STATE_FILE);
    $s = readStateFile();
    $result = $mutator($s);
    if (is_array($result) && isset($result['error'])) {
        flock($lk, LOCK_UN);
        fclose($lk);
        return $result;
    }

    $s['rev'] = $s['rev'] + 1;
    $json = json_encode($s, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false) $json = '{"error":"encode"}';

    $written = false;
    $tmp = STATE_FILE . '.tmp';
    if (file_put_contents($tmp, $json) !== false) {
        if (@rename($tmp, STATE_FILE)) {
            $written = true;
        } else {
            @unlink($tmp);
        }
    }
    if (!$written) { // fallback: write in place (only reached if tmp+rename failed)
        $fp = @fopen(STATE_FILE, 'c+');
        if ($fp) {
            ftruncate($fp, 0);
            fwrite($fp, $json);
            fflush($fp);
            fclose($fp);
        }
    }

    flock($lk, LOCK_UN);
    fclose($lk);
    return array('state' => $s);
}

function isSafeId($id) {
    return is_string($id) && preg_match('/^[A-Za-z0-9_-]{2,48}$/', $id) === 1;
}

function isSafeImg($img) {
    return is_string($img)
        && preg_match('/^[A-Za-z0-9_-]{1,64}$/', $img) === 1
        && is_file(IMAGES_DIR . '/' . $img . '.png');
}

function coordOk($xy, $size) {
    return is_numeric($xy) && $xy >= 0 && $xy < $size;
}

function cellBlocked($s, $type, $x, $y) {
    foreach ($s['pieces'] as $p) {
        if ((int)$p['x'] === (int)$x && (int)$p['y'] === (int)$y) return 'piece';
    }
    if ($type === 'piece') {
        foreach ($s['chips'] as $c) {
            if ((int)$c['x'] === (int)$x && (int)$c['y'] === (int)$y) return 'chip';
        }
    }
    return null;
}

/**
 * Mutators — return null on success (state is saved) or array('error' => msg).
 */

function actResize(&$s, $a) {
    $size = max(1, min(MAX_SIZE, (int)$a['size']));
    $s['grid']['size'] = $size;
    foreach (array('pieces', 'chips', 'pings') as $k) {
        $s[$k] = array_values(array_filter($s[$k], function ($o) use ($size) {
            return (int)$o['x'] < $size && (int)$o['y'] < $size;
        }));
    }
    return null;
}

function actCreate(&$s, $a) {
    $type = $a['type'];
    if ($type !== 'piece' && $type !== 'chip') return array('error' => 'bad type');
    if (!isSafeId($a['id'])) return array('error' => 'bad id');
    if (!isSafeImg($a['img'])) return array('error' => 'bad img');
    $color = $a['color'];
    if (!in_array($color, $GLOBALS['VALID_COLORS'], true)) return array('error' => 'bad color');
    $sx = $s['grid']['size'];
    $x = (int)$a['x']; $y = (int)$a['y'];
    if (!coordOk($x, $sx) || !coordOk($y, $sx)) return array('error' => 'out of bounds');

    $key = ($type === 'piece') ? 'pieces' : 'chips';
    foreach ($s[$key] as $o) if ($o['id'] === $a['id']) return array('error' => 'id taken');
    if (cellBlocked($s, $type, $x, $y)) return array('error' => 'cell occupied');

    $s[$key][] = array(
        'id'        => $a['id'],
        'img'       => $a['img'],
        'color'     => $color,
        'x'         => $x,
        'y'         => $y,
        'buttons'   => array('red' => 0, 'grey' => 0),
        'exhausted' => 1,
    );
    return null;
}

function actExhaust(&$s, $a) {
    if ($a['type'] !== 'piece') return array('error' => 'bad type');
    foreach ($s['pieces'] as $i => $o) {
        if ($o['id'] === $a['id']) {
            $o['exhausted'] = isset($a['exhausted']) ? ((int)$a['exhausted'] ? 1 : 0) : 1;
            $s['pieces'][$i] = $o;
            return null;
        }
    }
    return array('error' => 'not found');
}

function actMove(&$s, $a) {
    $type = $a['type'];
    if ($type !== 'piece' && $type !== 'chip') return array('error' => 'bad type');
    $key = ($type === 'piece') ? 'pieces' : 'chips';
    $sx = $s['grid']['size'];
    $x = (int)$a['x']; $y = (int)$a['y'];
    if (!coordOk($x, $sx) || !coordOk($y, $sx)) return array('error' => 'out of bounds');

    $idx = -1;
    $target = null;
    foreach ($s[$key] as $i => $o) {
        if ($o['id'] === $a['id']) { $idx = $i; $target = $o; break; }
    }
    if ($idx === -1) return array('error' => 'not found');

    $blocked = cellBlocked($s, $type, $x, $y);
    $sameCell = $target['x'] == $x && $target['y'] == $y;
    if ($blocked && !$sameCell) return array('error' => 'cell occupied');

    $target['x'] = $x;
    $target['y'] = $y;
    $s[$key][$idx] = $target;
    return null;
}

function actCounter(&$s, $a) {
    $type = $a['type'];
    if ($type !== 'piece' && $type !== 'chip') return array('error' => 'bad type');
    if ($a['which'] !== 'red' && $a['which'] !== 'grey') return array('error' => 'bad counter');
    $key = ($type === 'piece') ? 'pieces' : 'chips';
    foreach ($s[$key] as $i => $o) {
        if ($o['id'] === $a['id']) {
            if (isset($a['value'])) {
                $o['buttons'][$a['which']] = max(0, (int)$a['value']);
            } else {
                $v = (int)$o['buttons'][$a['which']];
                $v += ($a['delta'] > 0) ? 1 : -1;
                if ($v < 0) $v = 0;
                $o['buttons'][$a['which']] = $v;
            }
            $s[$key][$i] = $o;
            return null;
        }
    }
    return array('error' => 'not found');
}

function actPing(&$s, $a) {
    $color = $a['color'];
    if (!in_array($color, $GLOBALS['VALID_COLORS'], true)) return array('error' => 'bad color');
    $sx = $s['grid']['size'];
    $x = (int)$a['x']; $y = (int)$a['y'];
    if (!coordOk($x, $sx) || !coordOk($y, $sx)) return array('error' => 'out of bounds');
    $s['pings'][] = array('color' => $color, 'x' => $x, 'y' => $y, 't' => time());
    return null;
}

/* ---- request routing ---- */

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET' && isset($_GET['debug'])) {
    respond(array(
        'php'          => PHP_VERSION,
        'max_defined'  => defined('MAX_SIZE') ? MAX_SIZE : 'NOT DEFINED',
        'frozen_min'   => max(1, min(40, 18)),
        'state_bytes'  => base64_encode((string)@file_get_contents(STATE_FILE)),
        'state_exists' => file_exists(STATE_FILE) ? 'yes' : 'no',
        'images'       => IMAGES_DIR,
    ));
}

if ($method === 'GET') {
    if (isset($_GET['pieces'])) {
        $files = glob(IMAGES_DIR . '/*.png');
        $list = array();
        if ($files !== false) {
            natsort($files);
            foreach ($files as $f) {
                $base = basename($f, '.png');
                $parts = preg_split('/[^A-Za-z0-9]+/', $base, 2);
                $list[] = array('file' => $base, 'label' => $parts[0] !== '' ? $parts[0] : $base);
            }
        }
        respond(array('ok' => true, 'pieces' => $list));
    } else {
        $s = readStateFile();
        respond(array('ok' => true, 'state' => $s));
    }
}

if ($method === 'POST') {
    $raw = file_get_contents('php://input');
    if (strlen($raw) > $PACKET_LIMIT || $raw === false) {
        respond(array('ok' => false, 'error' => 'payload too large'));
    }
    $a = json_decode($raw, true);
    if (!is_array($a)) {
        respond(array('ok' => false, 'error' => 'bad payload'));
    }
    if (isset($a['batch'])) {
        $batch = $a['batch'];
        if (!is_array($batch) || count($batch) === 0 || count($batch) > 200) {
            respond(array('ok' => false, 'error' => 'bad payload'));
        }
        $actions = array();
        foreach ($batch as $b) {
            if (!is_array($b) || !isset($b['action'])) respond(array('ok' => false, 'error' => 'bad payload'));
            if (!in_array($b['action'], $VALID_ACTIONS, true)) respond(array('ok' => false, 'error' => 'unknown action'));
            $actions[] = $b;
        }
        $res = mutateState(function (&$s) use ($actions) {
            foreach ($actions as $act) {
                $r = null;
                switch ($act['action']) {
                    case 'resize':  $r = actResize($s, $act);  break;
                    case 'create':  $r = actCreate($s, $act);  break;
                    case 'move':    $r = actMove($s, $act);    break;
                    case 'counter': $r = actCounter($s, $act); break;
                    case 'exhaust': $r = actExhaust($s, $act); break;
                    case 'ping':    $r = actPing($s, $act);    break;
                }
                if (is_array($r) && isset($r['error'])) return $r;   // abort the whole batch, nothing saved
            }
            return null;
        });
        if (isset($res['error'])) respond(array('ok' => false, 'error' => $res['error']));
        respond(array('ok' => true, 'state' => $res['state']));
    }
    if (!isset($a['action'])) respond(array('ok' => false, 'error' => 'bad payload'));
    $action = $a['action'];
    if (!in_array($action, $VALID_ACTIONS, true)) {
        respond(array('ok' => false, 'error' => 'unknown action'));
    }

    $res = mutateState(function (&$s) use ($action, $a) {
        switch ($action) {
            case 'resize':  return actResize($s, $a);
            case 'create':  return actCreate($s, $a);
            case 'move':    return actMove($s, $a);
            case 'counter': return actCounter($s, $a);
            case 'exhaust': return actExhaust($s, $a);
            case 'ping':    return actPing($s, $a);
        }
        return array('error' => 'unknown action');
    });

    if (isset($res['error'])) respond(array('ok' => false, 'error' => $res['error']));
    respond(array('ok' => true, 'state' => $res['state']));
}

respond(array('ok' => false, 'error' => 'unsupported'));