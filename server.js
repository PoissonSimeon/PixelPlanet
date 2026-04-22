/**
 * PIXEL PLANET - Serveur MMO Hardcore "Single-File"
 * Architecture : Node.js + ws
 * Contrainte : < 512 Mo RAM
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// --- 1. CONFIGURATION DU MONDE ---
const PORT = 80;
const BOARD_SIZE = 1000;
const TICK_RATE = 1000 / 30; // 30 Hz
const SAVE_INTERVAL = 60000; // 60s

// Fichiers de persistance
const BOARD_FILE = path.join(__dirname, 'board.dat');
const USERS_FILE = path.join(__dirname, 'users.json');
const CADASTRE_FILE = path.join(__dirname, 'cadastre.json');
const ALANSTORE_FILE = path.join(__dirname, 'alanstore.json');

// Dictionnaire des Palettes (Client-side sync)
const COLORS = {
    0: '#FFFFFF', // Nature (Pixelium spawn)
    1: '#8B4513', // Terre
    2: '#4F4F4F', // Route
    3: '#C0C0C0', // Rail
    10: '#000080', // Etabli
    11: '#FF1493', // Peinture
    14: '#2F4F4F', // Coffre
    20: '#D2B48C', 21: '#E63946', 22: '#4CC9F0', 23: '#06D6A0', 24: '#FFD166', 25: '#8338EC', 26: '#FF99C8', // Bois
    30: '#A9A9A9', 31: '#A02831', 32: '#308099', 33: '#048C68', 34: '#B39247', 35: '#532396', 36: '#B36B8C'  // Pierre
};

// --- 2. ÉTAT DU SERVEUR (RAM) ---
let board; // Uint8Array(1,000,000) -> 1 Mo
let usersDb = {};
let cadastre = [];
let alanStore = { occasion: [] };

// État volatile (Sessions actives)
const activePlayers = new Map(); // ws.id -> { x, y, hp, stamina, job, lastAction, ... }
const pixelUpdates = new Map();  // File d'attente des modifications de pixels

// --- 3. INITIALISATION ET PERSISTANCE ---
function initFiles() {
    // Chargement Board
    if (fs.existsSync(BOARD_FILE)) {
        board = fs.readFileSync(BOARD_FILE);
        console.log(`[INIT] Board chargé (1 Mo).`);
    } else {
        board = Buffer.alloc(BOARD_SIZE * BOARD_SIZE);
        board.fill(0); // Rempli de Blanc Pur (Nature)
        console.log('[INIT] Nouveau monde généré.');
    }

    // Chargement sécurisé des JSONs
    try { if (fs.existsSync(USERS_FILE)) usersDb = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(e) { console.error("Erreur chargement users.json", e); }
    try { if (fs.existsSync(CADASTRE_FILE)) cadastre = JSON.parse(fs.readFileSync(CADASTRE_FILE, 'utf8')); } catch(e) { console.error("Erreur chargement cadastre.json", e); }
    try { if (fs.existsSync(ALANSTORE_FILE)) alanStore = JSON.parse(fs.readFileSync(ALANSTORE_FILE, 'utf8')); } catch(e) { console.error("Erreur chargement alanstore.json", e); }
}
initFiles();

function saveFiles() {
    fs.writeFile(BOARD_FILE, board, (err) => { if(err) console.error(err); });
    fs.writeFile(USERS_FILE, JSON.stringify(usersDb), (err) => { if(err) console.error(err); });
    fs.writeFile(CADASTRE_FILE, JSON.stringify(cadastre), (err) => { if(err) console.error(err); });
    fs.writeFile(ALANSTORE_FILE, JSON.stringify(alanStore), (err) => { if(err) console.error(err); });
}
setInterval(saveFiles, SAVE_INTERVAL);

// Mathématiques spatiales
const getIndex = (x, y) => (y * BOARD_SIZE) + x;
const wrap = (val, max) => ((val % max) + max) % max; // Torique

// --- 4. MÉCANIQUES DE GAME DESIGN ---

// Hachage mot de passe (Sécurité locale)
function hashPassword(password) {
    const salt = "PixelPlanetSalt2026";
    return crypto.scryptSync(password, salt, 64).toString('hex');
}

// Validation Cadastre
function canModify(username, x, y) {
    const zone = cadastre.find(z => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h);
    if (!zone) return true; // Zone publique
    if (zone.owner === username || zone.guests.includes(username)) return true;
    return false;
}

// Respawn Aléatoire (anti-bloquage)
function getRandomSpawn() {
    return { x: Math.floor(Math.random() * BOARD_SIZE), y: Math.floor(Math.random() * BOARD_SIZE) };
}

// --- 5. SERVEUR HTTP (Front-End) ---
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(FRONTEND_HTML);
        return;
    }
    if (req.method === 'GET' && req.url === '/board.dat') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(board);
        return;
    }
    res.writeHead(404);
    res.end('Not Found');
});

// --- 6. WEBSOCKET ET BOUCLE DE JEU ---
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    ws.id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
    ws.user = null;

    ws.on('message', (message) => {
        try {
            // Conversion vitale du Buffer en String avant de parser
            const data = JSON.parse(message.toString());
            
            // 6.1. AUTHENTIFICATION
            if (data.type === 'auth') {
                const user = data.user ? data.user.trim() : "";
                const pass = data.pass;
                const isRegister = data.isRegister;
                
                if (!user || !pass || user.length < 3) {
                    return ws.send(JSON.stringify({ type: 'error', msg: 'Le pseudo doit faire au moins 3 caractères et le mot de passe est requis.' }));
                }
                
                const hashedPass = hashPassword(pass);

                if (isRegister) {
                    if (usersDb[user]) return ws.send(JSON.stringify({ type: 'error', msg: 'Ce pseudo est déjà pris.' }));
                    const spawn = getRandomSpawn();
                    usersDb[user] = { 
                        pass: hashedPass, pix: 100, hp: 100, stamina: 100, job: "chômeur",
                        x: spawn.x, y: spawn.y, inventory: [] 
                    };
                } else {
                    if (!usersDb[user] || usersDb[user].pass !== hashedPass) {
                        return ws.send(JSON.stringify({ type: 'error', msg: 'Compte inexistant ou mauvais mot de passe.' }));
                    }
                }

                ws.user = user;
                activePlayers.set(ws.id, { 
                    user: user, x: usersDb[user].x, y: usersDb[user].y, 
                    hp: usersDb[user].hp, stamina: usersDb[user].stamina, job: usersDb[user].job,
                    lastMove: Date.now()
                });

                ws.send(JSON.stringify({ 
                    type: 'auth_success', 
                    state: usersDb[user],
                    colors: COLORS
                }));
                return;
            }

            if (!ws.user) return; // Garde-fou
            const playerState = activePlayers.get(ws.id);
            if (!playerState) return;
            const dbRef = usersDb[ws.user];

            // 6.2. DÉPLACEMENT (Torique)
            if (data.type === 'move') {
                playerState.x = wrap(data.x, BOARD_SIZE);
                playerState.y = wrap(data.y, BOARD_SIZE);
                playerState.lastMove = Date.now();
                dbRef.x = playerState.x;
                dbRef.y = playerState.y;
            }

            // 6.3. INTERACTIONS (Clic)
            if (data.type === 'interact') {
                const tx = wrap(data.x, BOARD_SIZE);
                const ty = wrap(data.y, BOARD_SIZE);
                
                // Distance Check (max 15 pixels)
                const dist = Math.hypot(playerState.x - tx, playerState.y - ty);
                if (dist > 15) return ws.send(JSON.stringify({ type: 'error', msg: 'Cible trop éloignée !' }));

                const idx = getIndex(tx, ty);
                const targetId = board[idx];

                // NEXUS (Changement de métier)
                if (tx >= 475 && tx <= 525 && ty >= 475 && ty <= 525 && data.action === 'change_job') {
                    if (data.job) {
                        playerState.job = data.job;
                        dbRef.job = data.job;
                        ws.send(JSON.stringify({ type: 'sys', msg: `Nouveau métier : ${data.job.toUpperCase()}`}));
                    }
                    return;
                }

                // Vérification Stamina pour actions physiques
                if (dbRef.stamina < 1) return ws.send(JSON.stringify({ type: 'error', msg: 'Endurance épuisée. Reposez-vous 1 min.' }));

                // Logique selon Métier
                if (playerState.job === 'ouvrier') {
                    if (data.action === 'mine' && targetId === 0) { // Mine Pixelium
                        pixelUpdates.set(`${tx},${ty}`, 20); // Devient terre/bois clair après minage
                        dbRef.stamina -= 1;
                        dbRef.inventory.push({ id: 'pixelium', qty: 1 });
                        ws.send(JSON.stringify({ type: 'sys', msg: '+1 Pixelium' }));
                    }
                    if (targetId === 10 && data.action === 'craft') { // Etabli
                        const pIx = dbRef.inventory.findIndex(i => i.id === 'pixelium');
                        if (pIx > -1 && dbRef.inventory[pIx].qty > 0) {
                            dbRef.inventory[pIx].qty--;
                            dbRef.pix += 10;
                            dbRef.stamina -= 1;
                            ws.send(JSON.stringify({ type: 'sys', msg: 'Pixelium transformé en 10 Pix !' }));
                        }
                    }
                } 
                else if (playerState.job === 'bâtisseur') {
                    if (data.action === 'build' && data.colorId !== undefined) {
                        if (!canModify(ws.user, tx, ty)) return ws.send(JSON.stringify({ type: 'error', msg: 'Ceci est un Terrain Privé.' }));
                        pixelUpdates.set(`${tx},${ty}`, data.colorId);
                        dbRef.stamina -= 1;
                    }
                }
                else if (playerState.job === 'guerrier') {
                    if (data.action === 'shoot') {
                        dbRef.stamina -= 1;
                        for (let [oid, ostate] of activePlayers.entries()) {
                            if (oid !== ws.id && Math.hypot(ostate.x - tx, ostate.y - ty) < 3) {
                                usersDb[ostate.user].hp -= 20;
                                if (usersDb[ostate.user].hp <= 0) {
                                    alanStore.occasion.push(...usersDb[ostate.user].inventory);
                                    usersDb[ostate.user].inventory = [];
                                    usersDb[ostate.user].hp = 100;
                                    const rsp = getRandomSpawn();
                                    usersDb[ostate.user].x = rsp.x; usersDb[ostate.user].y = rsp.y;
                                    ostate.x = rsp.x; ostate.y = rsp.y; ostate.hp = 100;
                                    ws.send(JSON.stringify({ type: 'sys', msg: `Vous avez abattu ${ostate.user} !` }));
                                }
                                break;
                            }
                        }
                    }
                }
                
                // Synchronisation immédiate des jauges pour le client
                playerState.stamina = dbRef.stamina;
                playerState.hp = dbRef.hp;
                ws.send(JSON.stringify({ type: 'sync_stats', pix: dbRef.pix, hp: dbRef.hp, stamina: dbRef.stamina, inv: dbRef.inventory }));
            }
            
            // 6.4 ALAN STORE
            if (data.type === 'alanstore_buy') {
                if (data.item === 'pioche' && dbRef.pix >= 1000) {
                    dbRef.pix -= 1000;
                    dbRef.inventory.push({ id: 'pioche', speed: Math.floor(Math.random() * 10) + 1 });
                    ws.send(JSON.stringify({ type: 'sync_stats', pix: dbRef.pix, hp: dbRef.hp, stamina: dbRef.stamina, inv: dbRef.inventory }));
                    ws.send(JSON.stringify({ type: 'sys', msg: 'Pioche achetée !' }));
                } else if (data.item === 'bloc_peinture' && dbRef.pix >= 5000) {
                    dbRef.pix -= 5000;
                    ws.send(JSON.stringify({ type: 'sync_stats', pix: dbRef.pix, hp: dbRef.hp, stamina: dbRef.stamina, inv: dbRef.inventory }));
                    ws.send(JSON.stringify({ type: 'sys', msg: 'Bloc Peinture acheté !' }));
                } else {
                    ws.send(JSON.stringify({ type: 'error', msg: 'Fonds insuffisants !' }));
                }
            }

        } catch (err) {
            console.error("Erreur WebSocket WS:", err);
        }
    });

    ws.on('close', () => {
        if (ws.user) {
            activePlayers.delete(ws.id);
        }
    });
});

// --- 7. GAME LOOP (30 Hz) ---
setInterval(() => {
    const now = Date.now();
    const deltas = [];

    // 7.1 Appliquer les modifications de pixels (File d'attente)
    for (let [coord, colorId] of pixelUpdates.entries()) {
        const [x, y] = coord.split(',').map(Number);
        const idx = getIndex(x, y);
        if (board[idx] !== colorId) {
            board[idx] = colorId;
            deltas.push({ x, y, c: colorId });
        }
    }
    pixelUpdates.clear();

    // 7.2 Régénération Repos (Stamina)
    for (let [id, state] of activePlayers.entries()) {
        const dbRef = usersDb[state.user];
        if (dbRef && now - state.lastMove > 60000) { // Immobile 60s
            if (Math.random() < 0.05 && dbRef.stamina < 100) { // Tick rate lent pour regen
                dbRef.stamina++;
                state.stamina = dbRef.stamina;
            }
        }
    }

    // 7.3 Spawn Naturel de Pixelium (Eco)
    if (Math.random() < 0.1) {
        const rx = Math.floor(Math.random() * BOARD_SIZE);
        const ry = Math.floor(Math.random() * BOARD_SIZE);
        if (board[getIndex(rx, ry)] === 0) { // Pousse sur le blanc pur
            pixelUpdates.set(`${rx},${ry}`, 0); // Visuellement déclenche un event client sans changer d'ID
        }
    }

    // 7.4 Broadcast (Optimisé)
    const playersData = Array.from(activePlayers.values()).map(p => ({ u: p.user, x: p.x, y: p.y }));
    const broadcastMsg = JSON.stringify({ type: 'tick', p: playersData, d: deltas });

    wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(broadcastMsg); // 1 = OPEN
    });

}, TICK_RATE);


server.listen(PORT, () => {
    console.log(`[SERVEUR] Pixel Planet actif sur le port ${PORT}`);
});

// ============================================================================
// ========================= FRONTEND (HTML / CSS / JS) =======================
// ============================================================================
const FRONTEND_HTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Pixel Planet - Hardcore MMO</title>
    <style>
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #000; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: white; user-select: none; }
        
        /* CANVAS */
        #game-canvas { display: block; width: 100%; height: 100%; cursor: crosshair; }
        
        /* UI OVERLAY */
        #ui-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 10; display: flex; flex-direction: column; justify-content: space-between; }
        
        /* TOP BAR */
        .top-bar { background: rgba(0,0,0,0.8); padding: 10px 20px; display: flex; justify-content: space-between; align-items: center; pointer-events: auto; border-bottom: 1px solid #333; }
        .stats-group { display: flex; gap: 20px; align-items: center; }
        .stat-bar { width: 150px; height: 15px; background: #333; border-radius: 10px; overflow: hidden; position: relative; border: 1px solid #555; }
        .stat-fill { height: 100%; transition: width 0.2s; }
        .hp-fill { background: #e74c3c; }
        .stam-fill { background: #f1c40f; }
        .stat-text { position: absolute; top: -2px; width: 100%; text-align: center; font-size: 11px; font-weight: bold; text-shadow: 1px 1px 2px black; }
        .pix-count { font-size: 18px; font-weight: bold; color: #f39c12; }
        .job-tag { background: #2980b9; padding: 4px 10px; border-radius: 5px; font-weight: bold; text-transform: uppercase; font-size: 12px; }
        
        /* CONTROLS (BOTTOM) */
        .bottom-bar { background: rgba(0,0,0,0.9); padding: 15px; pointer-events: auto; display: flex; justify-content: center; gap: 15px; border-top: 1px solid #333; }
        .btn { background: #34495e; color: white; border: 1px solid #555; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; transition: 0.2s; }
        .btn:hover:not(:disabled) { background: #2c3e50; border-color: #f39c12; }
        .btn.active { background: #27ae60; }
        .btn:disabled { background: #555; color: #aaa; cursor: not-allowed; }
        
        /* MODALS */
        .modal { display: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(20,20,20,0.95); padding: 30px; border-radius: 15px; border: 1px solid #555; box-shadow: 0 10px 30px rgba(0,0,0,0.8); z-index: 100; pointer-events: auto; text-align: center; }
        .modal.show { display: block; }
        .modal input { display: block; width: 100%; margin: 10px 0; padding: 10px; background: #000; border: 1px solid #444; color: white; border-radius: 5px; box-sizing: border-box; }
        .modal h2 { margin-top: 0; color: #f39c12; }
        
        /* NOTIFICATIONS */
        #notif { position: absolute; top: 70px; left: 50%; transform: translateX(-50%); padding: 10px 20px; border-radius: 20px; font-weight: bold; opacity: 0; transition: opacity 0.3s; pointer-events: none; text-shadow: 1px 1px 2px rgba(0,0,0,0.5); z-index: 50; }
        
        /* PALETTE (Builder) */
        #palette { display: none; position: absolute; bottom: 80px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.8); padding: 10px; border-radius: 10px; pointer-events: auto; gap: 5px; border: 1px solid #444; }
        .color-swatch { width: 25px; height: 25px; border-radius: 5px; cursor: pointer; border: 1px solid #fff; }
    </style>
</head>
<body>

    <canvas id="game-canvas"></canvas>

    <div id="ui-layer">
        <div class="top-bar">
            <div class="stats-group">
                <div class="job-tag" id="ui-job">Connexion...</div>
                <div>
                    <div class="stat-bar"><div class="stat-fill hp-fill" id="ui-hp" style="width: 100%;"></div><div class="stat-text" id="ui-hp-txt">100 HP</div></div>
                    <div class="stat-bar" style="margin-top: 5px;"><div class="stat-fill stam-fill" id="ui-stam" style="width: 100%;"></div><div class="stat-text" id="ui-stam-txt">100 STAMINA</div></div>
                </div>
            </div>
            <div class="pix-count">🪙 <span id="ui-pix">0</span> Pix</div>
            <button class="btn" onclick="openStore()">AlanStore</button>
        </div>

        <div id="notif">Message</div>

        <div id="palette"></div>

        <div class="bottom-bar">
            <button class="btn" id="btn-interact">Interagir (Clic)</button>
            <button class="btn" onclick="document.getElementById('modal-nexus').classList.add('show')">Nexus (Métiers)</button>
        </div>
    </div>

    <!-- MODAL LOGIN -->
    <div class="modal show" id="modal-login">
        <h2>PIXEL PLANET</h2>
        <p>Connexion sécurisée.</p>
        <input type="text" id="inp-user" placeholder="Pseudonyme">
        <input type="password" id="inp-pass" placeholder="Mot de passe">
        <button class="btn" id="btn-login" onclick="auth(false)" disabled>Chargement map...</button>
        <button class="btn" id="btn-reg" onclick="auth(true)" style="background: #8e44ad;" disabled>Patientez...</button>
    </div>

    <!-- MODAL NEXUS -->
    <div class="modal" id="modal-nexus">
        <h2>NEXUS - Bureau des Emplois</h2>
        <p>Choisissez votre voie. Coût: Gratuit.</p>
        <button class="btn" onclick="changeJob('ouvrier')">⛏️ Ouvrier</button>
        <button class="btn" onclick="changeJob('bâtisseur')">🧱 Bâtisseur</button>
        <button class="btn" onclick="changeJob('fermier')">🌾 Fermier</button>
        <button class="btn" onclick="changeJob('guerrier')">⚔️ Guerrier</button>
        <br><br>
        <button class="btn" onclick="document.getElementById('modal-nexus').classList.remove('show')">Fermer</button>
    </div>

    <!-- MODAL ALAN STORE -->
    <div class="modal" id="modal-store">
        <h2>AlanStore</h2>
        <p>Tarifs exorbitants. Favorisez le P2P.</p>
        <button class="btn" onclick="buyStore('pioche')">Pioche de minage (1000 Pix)</button>
        <button class="btn" onclick="buyStore('bloc_peinture')">Bloc Peinture (5000 Pix)</button>
        <br><br>
        <button class="btn" onclick="document.getElementById('modal-store').classList.remove('show')">Fermer</button>
    </div>

    <script>
        const canvas = document.getElementById('game-canvas');
        const ctx = canvas.getContext('2d', { alpha: false });
        let ws;
        
        // Moteur Visuel
        const BOARD_SIZE = 1000;
        let scale = 15; // Zoom par défaut
        let camX = 500, camY = 500;
        let myUser = null;
        let myJob = null;
        let selectedColorId = 20; // Default bois
        
        // Données
        let offCanvas = document.createElement('canvas');
        offCanvas.width = BOARD_SIZE;
        offCanvas.height = BOARD_SIZE;
        let offCtx = offCanvas.getContext('2d', { alpha: false });
        let playersMap = [];
        let colorDict = {};

        // Resize
        function resize() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            draw();
        }
        window.addEventListener('resize', resize);
        resize();

        // Afficher notif avec couleur d'erreur optionnelle
        function notify(msg, isError = false) {
            const el = document.getElementById('notif');
            el.innerText = msg;
            el.style.background = isError ? 'rgba(231, 76, 60, 0.95)' : 'rgba(46, 204, 113, 0.95)';
            el.style.opacity = 1;
            setTimeout(() => el.style.opacity = 0, 3000);
        }

        // --- RESEAU ---
        function initNet() {
            fetch('/board.dat').then(res => res.arrayBuffer()).then(buffer => {
                const view = new Uint8Array(buffer);
                const imgData = offCtx.createImageData(BOARD_SIZE, BOARD_SIZE);
                connectSocket(view, imgData);
            }).catch(err => {
                document.getElementById('btn-login').innerText = "Erreur Chargement Map";
            });
        }

        function connectSocket(rawView, imgData) {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + window.location.host);

            ws.onopen = () => {
                // Débloque les boutons de l'UI une fois la connexion validée
                document.getElementById('btn-login').disabled = false;
                document.getElementById('btn-login').innerText = "Se connecter";
                document.getElementById('btn-reg').disabled = false;
                document.getElementById('btn-reg').innerText = "Créer un compte";
            };

            ws.onmessage = (e) => {
                const data = JSON.parse(e.data);

                if (data.type === 'auth_success') {
                    document.getElementById('modal-login').classList.remove('show');
                    myUser = document.getElementById('inp-user').value.trim();
                    colorDict = data.colors;
                    camX = data.state.x;
                    camY = data.state.y;
                    updateHUD(data.state);
                    buildPalette();
                    
                    // Rendu initial de la carte avec les bonnes couleurs
                    for (let i = 0; i < rawView.length; i++) {
                        const hex = colorDict[rawView[i]] || '#000000';
                        const r = parseInt(hex.slice(1, 3), 16);
                        const g = parseInt(hex.slice(3, 5), 16);
                        const b = parseInt(hex.slice(5, 7), 16);
                        imgData.data[i*4] = r; imgData.data[i*4+1] = g; imgData.data[i*4+2] = b; imgData.data[i*4+3] = 255;
                    }
                    offCtx.putImageData(imgData, 0, 0);
                    notify("Connexion réussie !");
                    
                    // Lancement Boucle de rendu
                    requestAnimationFrame(renderLoop);
                }
                
                else if (data.type === 'error') {
                    notify(data.msg, true);
                }
                
                else if (data.type === 'sys') {
                    notify(data.msg);
                }

                else if (data.type === 'sync_stats') {
                    updateHUD(data);
                }

                else if (data.type === 'tick') {
                    playersMap = data.p;
                    // Application des deltas
                    for (let d of data.d) {
                        offCtx.fillStyle = colorDict[d.c] || '#000';
                        offCtx.fillRect(d.x, d.y, 1, 1);
                    }
                }
            };
            
            ws.onclose = () => {
                notify("Connexion perdue avec le serveur.", true);
            };
        }

        function auth(isRegister) {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                notify("Connexion au serveur non établie. Veuillez patienter.", true);
                return;
            }
            const user = document.getElementById('inp-user').value.trim();
            const pass = document.getElementById('inp-pass').value;
            ws.send(JSON.stringify({ type: 'auth', user, pass, isRegister }));
        }

        function updateHUD(state) {
            if (state.job) {
                myJob = state.job;
                document.getElementById('ui-job').innerText = state.job;
                document.getElementById('palette').style.display = (myJob === 'bâtisseur') ? 'flex' : 'none';
            }
            if (state.hp !== undefined) {
                document.getElementById('ui-hp').style.width = state.hp + '%';
                document.getElementById('ui-hp-txt').innerText = state.hp + ' HP';
            }
            if (state.stamina !== undefined) {
                document.getElementById('ui-stam').style.width = state.stamina + '%';
                document.getElementById('ui-stam-txt').innerText = state.stamina + ' STAMINA';
            }
            if (state.pix !== undefined) {
                document.getElementById('ui-pix').innerText = state.pix;
            }
        }

        // --- CONTROLES ---
        const keys = { w:false, a:false, s:false, d:false };
        window.addEventListener('keydown', e => { 
            const k = e.key.toLowerCase(); 
            if(keys[k] !== undefined) keys[k] = true; 
        });
        window.addEventListener('keyup', e => { 
            const k = e.key.toLowerCase(); 
            if(keys[k] !== undefined) keys[k] = false; 
        });

        // Clic sur le Canvas (Action)
        canvas.addEventListener('mousedown', (e) => {
            if (!myUser) return;
            const rect = canvas.getBoundingClientRect();
            // Projection inverse de la caméra
            const cx = canvas.width / 2;
            const cy = canvas.height / 2;
            const worldX = Math.floor(camX + (e.clientX - rect.left - cx) / scale);
            const worldY = Math.floor(camY + (e.clientY - rect.top - cy) / scale);

            // Déterminer l'action selon le métier
            let action = 'interact';
            if (myJob === 'ouvrier') action = 'mine';
            if (myJob === 'bâtisseur') action = 'build';
            if (myJob === 'guerrier') action = 'shoot';

            ws.send(JSON.stringify({ type: 'interact', x: worldX, y: worldY, action: action, colorId: selectedColorId }));
        });

        // --- BOUCLE DE RENDU ET PHYSIQUE CLIENT ---
        let lastTime = performance.now();
        function renderLoop(time) {
            requestAnimationFrame(renderLoop);
            const dt = (time - lastTime) / 1000;
            lastTime = time;

            if (!myUser) return;

            // Déplacement local (Torique)
            const speed = 10; // Vitesse de base pure
            if (keys.w) camY -= speed * dt;
            if (keys.s) camY += speed * dt;
            if (keys.a) camX -= speed * dt;
            if (keys.d) camX += speed * dt;

            // Envoi pos au serveur (bridé à 10 Hz)
            if (Math.random() < 0.3) ws.send(JSON.stringify({ type: 'move', x: camX, y: camY }));

            // Rendu
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.save();
            ctx.translate(canvas.width / 2, canvas.height / 2);
            ctx.scale(scale, scale);
            ctx.translate(-camX, -camY);

            // Dessin de la map
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(offCanvas, 0, 0);
            
            // Effet Torique Visuel (dessine la map autour pour illusion infinie)
            ctx.drawImage(offCanvas, -BOARD_SIZE, 0);
            ctx.drawImage(offCanvas, BOARD_SIZE, 0);
            ctx.drawImage(offCanvas, 0, -BOARD_SIZE);
            ctx.drawImage(offCanvas, 0, BOARD_SIZE);

            // Dessin des joueurs
            for (let p of playersMap) {
                ctx.fillStyle = (p.u === myUser) ? '#f1c40f' : '#e74c3c';
                ctx.fillRect(p.x - 2, p.y - 2, 5, 5); // Hitbox 5x5
                ctx.fillStyle = 'white';
                ctx.font = '3px Arial';
                ctx.fillText(p.u, p.x - 3, p.y - 3);
            }

            ctx.restore();
        }

        // UI Interactions
        function changeJob(job) {
            ws.send(JSON.stringify({ type: 'interact', x: camX, y: camY, action: 'change_job', job: job }));
            document.getElementById('modal-nexus').classList.remove('show');
        }
        function openStore() { document.getElementById('modal-store').classList.add('show'); }
        function buyStore(item) { ws.send(JSON.stringify({ type: 'alanstore_buy', item })); document.getElementById('modal-store').classList.remove('show'); }

        function buildPalette() {
            const pal = document.getElementById('palette');
            pal.innerHTML = '';
            // Seulement les ids constructibles
            const buildable = [20, 21, 22, 23, 30, 31, 32, 2]; // Bois, Pierres, Route
            for (let id of buildable) {
                const div = document.createElement('div');
                div.className = 'color-swatch';
                div.style.backgroundColor = colorDict[id];
                div.onclick = () => {
                    selectedColorId = id;
                    document.querySelectorAll('.color-swatch').forEach(el => el.style.borderColor = 'white');
                    div.style.borderColor = '#f1c40f';
                };
                pal.appendChild(div);
            }
        }

        // Lancement Client
        initNet();

    </script>
</body>
</html>
`;
