/**
 * PIXEL PLANET - Serveur MMO Hardcore "Single-File"
 * Architecture : Node.js + ws
 * Contrainte : < 512 Mo RAM
 * Version : 1.4 (Coffres, Impôts, Magasins P2P intégrés)
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

const BOARD_FILE = path.join(__dirname, 'board.dat');
const USERS_FILE = path.join(__dirname, 'users.json');
const CADASTRE_FILE = path.join(__dirname, 'cadastre.json');
const ALANSTORE_FILE = path.join(__dirname, 'alanstore.json');
const SHOPS_FILE = path.join(__dirname, 'shops.json'); // Nouveau: Stockage des échoppes P2P

const COLORS = {
    0: '#FFFFFF', // Nature
    1: '#8B4513', // Terre
    2: '#4F4F4F', // Route
    3: '#C0C0C0', // Rail
    4: '#2ecc71', // Plante
    5: '#00FFFF', // Pixelium
    10: '#000080', // Etabli
    11: '#FF1493', // Peinture
    12: '#FF4500', // Garage
    13: '#FFD700', // Magasin (P2P)
    14: '#2F4F4F', // Coffre-fort (Persistance)
    15: '#8B0000', // Casse
    16: '#00CED1', // Entreprise
    20: '#D2B48C', 21: '#E63946', 22: '#4CC9F0', 23: '#06D6A0', 24: '#FFD166', 25: '#8338EC', 26: '#FF99C8', // Bois
    30: '#A9A9A9', 31: '#A02831', 32: '#308099', 33: '#048C68', 34: '#B39247', 35: '#532396', 36: '#B36B8C'  // Pierre
};

const DEF_FRAME = Array(25).fill(255);
DEF_FRAME[2]=24; DEF_FRAME[6]=24; DEF_FRAME[7]=24; DEF_FRAME[8]=24; DEF_FRAME[12]=24; DEF_FRAME[16]=24; DEF_FRAME[18]=24;
const DEFAULT_AVATAR = [DEF_FRAME, DEF_FRAME, DEF_FRAME];

// --- 2. ÉTAT DU SERVEUR ---
let board; 
let usersDb = {};
let cadastre = [];
let alanStore = { occasion: [] };
let playerShops = {}; // coord "x,y" -> { owner, item: {id, qty, ...}, price }

const activePlayers = new Map(); 
const pixelUpdates = new Map();  
const activeCrops = new Map(); 

// --- 3. INITIALISATION ---
function initFiles() {
    if (fs.existsSync(BOARD_FILE)) { board = fs.readFileSync(BOARD_FILE); } 
    else { board = Buffer.alloc(BOARD_SIZE * BOARD_SIZE); board.fill(0); }
    try { if (fs.existsSync(USERS_FILE)) usersDb = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch(e) {}
    try { if (fs.existsSync(CADASTRE_FILE)) cadastre = JSON.parse(fs.readFileSync(CADASTRE_FILE, 'utf8')); } catch(e) {}
    try { if (fs.existsSync(ALANSTORE_FILE)) alanStore = JSON.parse(fs.readFileSync(ALANSTORE_FILE, 'utf8')); } catch(e) {}
    try { if (fs.existsSync(SHOPS_FILE)) playerShops = JSON.parse(fs.readFileSync(SHOPS_FILE, 'utf8')); } catch(e) {}
}
initFiles();

function saveFiles() {
    fs.writeFile(BOARD_FILE, board, () => {});
    fs.writeFile(USERS_FILE, JSON.stringify(usersDb), () => {});
    fs.writeFile(CADASTRE_FILE, JSON.stringify(cadastre), () => {});
    fs.writeFile(ALANSTORE_FILE, JSON.stringify(alanStore), () => {});
    fs.writeFile(SHOPS_FILE, JSON.stringify(playerShops), () => {});
}
setInterval(saveFiles, SAVE_INTERVAL);

const getIndex = (x, y) => (y * BOARD_SIZE) + x;
const wrap = (val, max) => ((val % max) + max) % max; 
function toroidalDist(x1, y1, x2, y2) {
    let dx = Math.abs(x1 - x2), dy = Math.abs(y1 - y2);
    if (dx > BOARD_SIZE / 2) dx = BOARD_SIZE - dx;
    if (dy > BOARD_SIZE / 2) dy = BOARD_SIZE - dy;
    return Math.hypot(dx, dy);
}

// --- 4. MÉCANIQUES ---
function hashPassword(password) { return crypto.scryptSync(password, "PixelPlanetSalt2026", 64).toString('hex'); }
function isNexus(x, y) { return (x >= 475 && x < 525 && y >= 475 && y < 525); }
function getRandomSpawn() { return { x: 500 + Math.floor(Math.random() * 10 - 5), y: 500 + Math.floor(Math.random() * 10 - 5) }; }

function canModify(username, x, y) {
    if (isNexus(x, y)) return false; 
    const zone = cadastre.find(z => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h);
    if (!zone) return true; 
    return (zone.owner === username || zone.guests.includes(username));
}

// Gestion Inventaire & Coffre (Vault)
function giveItem(user, targetInv, id, qty = 1, props = {}) {
    const inv = usersDb[user][targetInv]; // 'inventory' ou 'vault'
    const existing = inv.find(i => i.id === id && !props.unique);
    if (existing) existing.qty += qty;
    else if (inv.length < 20) inv.push({ id, qty, ...props });
}

function consumeItem(user, targetInv, id, qty = 1) {
    const inv = usersDb[user][targetInv];
    const idx = inv.findIndex(i => i.id === id);
    if (idx > -1 && inv[idx].qty >= qty) {
        inv[idx].qty -= qty;
        if (inv[idx].qty <= 0) inv.splice(idx, 1);
        return true;
    }
    return false;
}

// --- 5. HTTP ---
const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(FRONTEND_HTML); return;
    }
    if (req.method === 'GET' && url === '/board.dat') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(board); return;
    }
    res.writeHead(404); res.end('Not Found');
});

// --- 6. WEBSOCKET ---
const wss = new WebSocketServer({ server });

const ALANSTORE_PRICES = {
    'graine': 50, 'pioche': 1000, 'arme': 3000, 'protection_pvp': 2000, 'etabli': 5000, 
    'bloc_peinture': 5000, 'bloc_magasin': 8000, 'moteur': 10000, 'bloc_garage': 10000, 
    'coffre': 15000, 'bloc_entreprise': 20000 
};

wss.on('connection', (ws) => {
    ws.id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
    ws.user = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            
            if (data.type === 'auth') {
                const user = data.user ? data.user.trim() : "";
                if (!user || !data.pass || user.length < 3) return ws.send(JSON.stringify({ type: 'error', msg: 'Pseudo invalide.' }));
                const hashedPass = hashPassword(data.pass);

                if (data.isRegister) {
                    if (usersDb[user]) return ws.send(JSON.stringify({ type: 'error', msg: 'Pseudo pris.' }));
                    const spawn = getRandomSpawn();
                    // Ajout du vault (Coffre-fort)
                    usersDb[user] = { pass: hashedPass, pix: 100, hp: 100, stamina: 100, job: "chômeur", x: spawn.x, y: spawn.y, inventory: [], vault: [], avatar: DEFAULT_AVATAR };
                } else {
                    if (!usersDb[user] || usersDb[user].pass !== hashedPass) return ws.send(JSON.stringify({ type: 'error', msg: 'Erreur login.' }));
                }

                if (!usersDb[user].avatar) usersDb[user].avatar = DEFAULT_AVATAR;
                if (!usersDb[user].vault) usersDb[user].vault = [];

                ws.user = user;
                activePlayers.set(ws.id, { user, x: usersDb[user].x, y: usersDb[user].y, isDriving: false, lastMove: 0 });

                const allAvatars = {};
                for (let u in usersDb) allAvatars[u] = usersDb[u].avatar;

                ws.send(JSON.stringify({ type: 'auth_success', state: usersDb[user], colors: COLORS, avatars: allAvatars }));
                return;
            }

            if (!ws.user) return;
            const playerState = activePlayers.get(ws.id);
            const dbRef = usersDb[ws.user];

            if (data.type === 'set_avatar') {
                if(data.frames && data.frames.length === 3) {
                    dbRef.avatar = data.frames;
                    ws.send(JSON.stringify({ type: 'sys', msg: 'Avatar mis à jour !' }));
                    wss.clients.forEach(c => { if(c.readyState === 1) c.send(JSON.stringify({ type: 'avatar_update', u: ws.user, a: data.frames })); });
                }
                return;
            }

            if (data.type === 'chat') {
                const msg = data.msg.substring(0, 100); 
                if (data.channel === 'global') {
                    if (dbRef.pix < 5) return ws.send(JSON.stringify({ type: 'error', msg: 'Fonds insuffisants (5 Pix).' }));
                    dbRef.pix -= 5;
                    ws.send(JSON.stringify({ type: 'sync_stats', pix: dbRef.pix }));
                    wss.clients.forEach(c => { if(c.readyState === 1) c.send(JSON.stringify({ type: 'chat', channel: 'global', user: ws.user, msg })); });
                } else {
                    wss.clients.forEach(c => {
                        if (c.readyState !== 1) return;
                        const otherState = activePlayers.get(c.id);
                        if (otherState && toroidalDist(otherState.x, otherState.y, playerState.x, playerState.y) < 100) {
                            c.send(JSON.stringify({ type: 'chat', channel: 'local', user: ws.user, msg }));
                        }
                    });
                }
                return;
            }

            if (data.type === 'move') {
                playerState.x = wrap(data.x, BOARD_SIZE); playerState.y = wrap(data.y, BOARD_SIZE);
                playerState.lastMove = Date.now();
                dbRef.x = playerState.x; dbRef.y = playerState.y;
            }

            if (data.type === 'use_item') {
                if (data.item === 'vehicule' || data.item === 'moteur') {
                    playerState.isDriving = !playerState.isDriving;
                    ws.send(JSON.stringify({ type: 'sys', msg: playerState.isDriving ? 'Contact allumé !' : 'Moteur coupé.' }));
                }
                if (data.item === 'plante') {
                    if (consumeItem(ws.user, 'inventory', 'plante', 1)) {
                        dbRef.stamina = 100;
                        ws.send(JSON.stringify({ type: 'sys', msg: 'Stamina restaurée !' }));
                    }
                }
                ws.send(JSON.stringify({ type: 'sync_stats', pix: dbRef.pix, hp: dbRef.hp, stamina: dbRef.stamina, inv: dbRef.inventory }));
                return;
            }

            // Transfert Coffre-Fort
            if (data.type === 'vault_transfer') {
                const itemIdx = data.index;
                if (data.direction === 'to_vault' && dbRef.inventory[itemIdx]) {
                    const it = dbRef.inventory[itemIdx];
                    giveItem(ws.user, 'vault', it.id, it.qty, it);
                    dbRef.inventory.splice(itemIdx, 1);
                } else if (data.direction === 'to_inv' && dbRef.vault[itemIdx]) {
                    const it = dbRef.vault[itemIdx];
                    giveItem(ws.user, 'inventory', it.id, it.qty, it);
                    dbRef.vault.splice(itemIdx, 1);
                }
                ws.send(JSON.stringify({ type: 'sync_stats', inv: dbRef.inventory, vault: dbRef.vault }));
                return;
            }

            // P2P Magasin : Mise en vente
            if (data.type === 'shop_sell') {
                const itemIdx = data.index;
                const price = parseInt(data.price);
                const coord = data.coord; // "x,y"
                if (playerShops[coord] && playerShops[coord].owner === ws.user && dbRef.inventory[itemIdx] && price > 0) {
                    playerShops[coord].item = dbRef.inventory[itemIdx];
                    playerShops[coord].price = price;
                    dbRef.inventory.splice(itemIdx, 1); // Retire de l'inventaire
                    ws.send(JSON.stringify({ type: 'sys', msg: 'Objet mis en vente !' }));
                    ws.send(JSON.stringify({ type: 'sync_stats', inv: dbRef.inventory }));
                }
                return;
            }

            // P2P Magasin : Achat
            if (data.type === 'shop_buy') {
                const coord = data.coord;
                const shop = playerShops[coord];
                if (shop && shop.item && dbRef.pix >= shop.price) {
                    dbRef.pix -= shop.price;
                    giveItem(ws.user, 'inventory', shop.item.id, shop.item.qty, shop.item);
                    
                    // Paiement asynchrone au propriétaire
                    if (usersDb[shop.owner]) usersDb[shop.owner].pix += shop.price;
                    
                    shop.item = null; // Vendu
                    ws.send(JSON.stringify({ type: 'sys', msg: 'Achat P2P réussi !' }));
                    ws.send(JSON.stringify({ type: 'sync_stats', pix: dbRef.pix, inv: dbRef.inventory }));
                } else {
                    ws.send(JSON.stringify({ type: 'error', msg: 'Fonds insuffisants ou objet vendu.' }));
                }
                return;
            }

            if (data.type === 'buy_land') {
                if (dbRef.pix < 100) return ws.send(JSON.stringify({ type: 'error', msg: 'Il faut 100 Pix.' }));
                const newZone = { id: crypto.randomUUID(), x: playerState.x - 5, y: playerState.y - 5, w: 10, h: 10, owner: ws.user, guests: [], cost: 100 };
                const overlap = cadastre.some(z => newZone.x < z.x+z.w && newZone.x+newZone.w > z.x && newZone.y < z.y+z.h && newZone.y+newZone.h > z.y);
                if (overlap) return ws.send(JSON.stringify({ type: 'error', msg: 'Zone occupée.' }));
                
                dbRef.pix -= 100; cadastre.push(newZone);
                ws.send(JSON.stringify({ type: 'sys', msg: 'Terrain acquis !' }));
                ws.send(JSON.stringify({ type: 'sync_stats', pix: dbRef.pix, inv: dbRef.inventory }));
                return;
            }

            if (data.type === 'interact') {
                const tx = wrap(data.x, BOARD_SIZE), ty = wrap(data.y, BOARD_SIZE);
                if (toroidalDist(playerState.x, playerState.y, tx, ty) > 15) return ws.send(JSON.stringify({ type: 'error', msg: 'Cible trop éloignée.' }));
                const idx = getIndex(tx, ty), targetId = board[idx];

                if (isNexus(tx, ty)) {
                    if (data.action === 'change_job') {
                        dbRef.job = data.job;
                        ws.send(JSON.stringify({ type: 'sys', msg: `Métier : ${data.job}`}));
                        ws.send(JSON.stringify({ type: 'sync_stats', job: dbRef.job }));
                    } else ws.send(JSON.stringify({ type: 'error', msg: 'Le Nexus est protégé.' }));
                    return;
                }

                // INTERACTIONS BLOCS SPÉCIAUX (Magasin & Coffre)
                if (data.action === 'interact') {
                    if (targetId === 14) { // Coffre-fort
                        if (!canModify(ws.user, tx, ty)) return ws.send(JSON.stringify({ type: 'error', msg: 'Ce coffre ne vous appartient pas.' }));
                        ws.send(JSON.stringify({ type: 'open_vault', vault: dbRef.vault }));
                        return;
                    }
                    if (targetId === 13) { // Magasin P2P
                        const coord = `${tx},${ty}`;
                        if (!playerShops[coord]) playerShops[coord] = { owner: ws.user, item: null, price: 0 }; // Init shop
                        
                        if (playerShops[coord].owner === ws.user) {
                            // C'est mon magasin : j'ouvre l'interface de gestion
                            ws.send(JSON.stringify({ type: 'manage_shop', coord, shop: playerShops[coord] }));
                        } else {
                            // C'est le magasin d'un autre : j'ouvre l'interface d'achat
                            ws.send(JSON.stringify({ type: 'view_shop', coord, shop: playerShops[coord] }));
                        }
                        return;
                    }
                }

                if (dbRef.stamina < 1) return ws.send(JSON.stringify({ type: 'error', msg: 'Épuisé. Mangez ou reposez-vous.' }));

                if (data.action === 'mine' && targetId === 5) {
                    if (dbRef.job !== 'ouvrier') return ws.send(JSON.stringify({ type: 'error', msg: 'Seul un Ouvrier peut extraire du Pixelium.' }));
                    pixelUpdates.set(`${tx},${ty}`, 0); dbRef.stamina -= 1; giveItem(ws.user, 'inventory', 'pixelium', 1);
                    ws.send(JSON.stringify({ type: 'sys', msg: '+1 Pixelium' }));
                }
                else if (data.action === 'craft' && targetId === 10) {
                    if (dbRef.job !== 'ouvrier') return ws.send(JSON.stringify({ type: 'error', msg: 'Seul un Ouvrier peut utiliser l\'établi.' }));
                    if (consumeItem(ws.user, 'inventory', 'pixelium', 1)) { dbRef.pix += 10; dbRef.stamina -= 1; ws.send(JSON.stringify({ type: 'sys', msg: '1 Pixelium -> 10 Pix' })); }
                    else ws.send(JSON.stringify({ type: 'error', msg: 'Pas de Pixelium.' }));
                }
                else if (data.action === 'build' && data.colorId !== undefined) {
                    if (dbRef.job !== 'bâtisseur' && dbRef.job !== 'vendeur') return ws.send(JSON.stringify({ type: 'error', msg: 'Métier inadapté.' }));
                    if (!canModify(ws.user, tx, ty)) return ws.send(JSON.stringify({ type: 'error', msg: 'Terrain Protégé.' }));
                    
                    // Seul le vendeur peut poser un magasin (13)
                    if (data.colorId === 13 && dbRef.job !== 'vendeur') return ws.send(JSON.stringify({ type: 'error', msg: 'Seul un vendeur pose un magasin.' }));

                    pixelUpdates.set(`${tx},${ty}`, data.colorId); dbRef.stamina -= 1;
                }
                else if (data.action === 'plant') {
                    if (dbRef.job !== 'fermier') return ws.send(JSON.stringify({ type: 'error', msg: 'Seul un Fermier peut planter.' }));
                    if (targetId !== 1) return ws.send(JSON.stringify({ type: 'error', msg: 'Planter sur Terre (1).' }));
                    if (!canModify(ws.user, tx, ty)) return ws.send(JSON.stringify({ type: 'error', msg: 'Terrain Protégé.' }));
                    pixelUpdates.set(`${tx},${ty}`, 4); activeCrops.set(`${tx},${ty}`, { plantedAt: Date.now(), owner: ws.user });
                    dbRef.stamina -= 1; ws.send(JSON.stringify({ type: 'sys', msg: 'Graine plantée !' }));
                }
                else if (data.action === 'harvest') {
                    if (dbRef.job !== 'fermier') return ws.send(JSON.stringify({ type: 'error', msg: 'Seul un Fermier récolte.' }));
                    if (targetId !== 4) return ws.send(JSON.stringify({ type: 'error', msg: 'Rien à récolter.' }));
                    const crop = activeCrops.get(`${tx},${ty}`);
                    if (crop && Date.now() - crop.plantedAt > 60000) { 
                        pixelUpdates.set(`${tx},${ty}`, 1); activeCrops.delete(`${tx},${ty}`);
                        giveItem(ws.user, 'inventory', 'plante', 1); dbRef.stamina -= 1;
                        ws.send(JSON.stringify({ type: 'sys', msg: '+1 Plante (Stamina)' }));
                    } else ws.send(JSON.stringify({ type: 'error', msg: 'Pousse en cours...' }));
                }
                else if (data.action === 'shoot') {
                    if (dbRef.job !== 'guerrier') return ws.send(JSON.stringify({ type: 'error', msg: 'Seul un Guerrier tire.' }));
                    dbRef.stamina -= 1;
                    for (let [oid, ostate] of activePlayers.entries()) {
                        if (oid !== ws.id && toroidalDist(ostate.x, ostate.y, tx, ty) < 4) {
                            if (isNexus(ostate.x, ostate.y)) { ws.send(JSON.stringify({ type: 'error', msg: 'Cible dans le Nexus.' })); continue; }
                            usersDb[ostate.user].hp -= ostate.isDriving ? 10 : 20; 
                            if (usersDb[ostate.user].hp <= 0) {
                                // PUNITIF: Seul l'inventaire tombe, le COFFRE EST SAUVÉ !
                                if (usersDb[ostate.user].inventory.length > 0) alanStore.occasion.push(...usersDb[ostate.user].inventory);
                                usersDb[ostate.user].inventory = []; usersDb[ostate.user].hp = 100;
                                const rsp = getRandomSpawn();
                                usersDb[ostate.user].x = rsp.x; usersDb[ostate.user].y = rsp.y;
                                ostate.x = rsp.x; ostate.y = rsp.y; ostate.isDriving = false;
                                ws.send(JSON.stringify({ type: 'sys', msg: `Kill: ${ostate.user}` }));
                            }
                            break;
                        }
                    }
                }
                ws.send(JSON.stringify({ type: 'sync_stats', hp: dbRef.hp, stamina: dbRef.stamina, inv: dbRef.inventory }));
            }
            
            if (data.type === 'alanstore_req') { ws.send(JSON.stringify({ type: 'alanstore_res', occ: alanStore.occasion, prices: ALANSTORE_PRICES })); return; }
            if (data.type === 'alanstore_buy_sys') {
                const cost = ALANSTORE_PRICES[data.item];
                if (cost && dbRef.pix >= cost) {
                    dbRef.pix -= cost;
                    let props = { unique: false };
                    if (data.item === 'pioche') props = { unique: true, speed: Math.floor(Math.random() * 10) + 1 };
                    else if (data.item === 'arme') props = { unique: true, dmg: Math.floor(Math.random() * 20) + 10 };
                    else if (data.item === 'moteur') props = { unique: true, mtype: 'Voiture', speed: Math.floor(Math.random() * 50) + 20 };
                    else if (data.item.startsWith('bloc_') || data.item === 'coffre' || data.item === 'etabli') props = { unique: true };

                    giveItem(ws.user, 'inventory', data.item, 1, props);
                    ws.send(JSON.stringify({ type: 'sync_stats', pix: dbRef.pix, inv: dbRef.inventory, job: dbRef.job }));
                    ws.send(JSON.stringify({ type: 'alanstore_res', occ: alanStore.occasion, prices: ALANSTORE_PRICES })); 
                } else ws.send(JSON.stringify({ type: 'error', msg: 'Fonds insuffisants.' }));
            }
            if (data.type === 'alanstore_buy_occ') {
                const idx = data.index, occPrice = 50; 
                if (alanStore.occasion[idx] && dbRef.pix >= occPrice) {
                    const item = alanStore.occasion[idx]; dbRef.pix -= occPrice; alanStore.occasion.splice(idx, 1); 
                    giveItem(ws.user, 'inventory', item.id, item.qty, item);
                    ws.send(JSON.stringify({ type: 'sync_stats', pix: dbRef.pix, inv: dbRef.inventory }));
                    ws.send(JSON.stringify({ type: 'alanstore_res', occ: alanStore.occasion, prices: ALANSTORE_PRICES })); 
                } else ws.send(JSON.stringify({ type: 'error', msg: 'Erreur ou Pix manquants.' }));
            }

        } catch (err) {}
    });

    ws.on('close', () => { 
        if (ws.user) {
            const dbRef = usersDb[ws.user];
            // INVENTAIRE PERDU, MAIS LE VAULT EST SAUVEGARDÉ !
            if (dbRef && dbRef.inventory.length > 0) { alanStore.occasion.push(...dbRef.inventory); dbRef.inventory = []; }
            activePlayers.delete(ws.id); 
        }
    });
});

// --- 7. GAME LOOP (30 Hz) ---
let lastMin = Date.now();
let lastHour = Date.now();

setInterval(() => {
    const now = Date.now();
    const deltas = [];

    for (let [coord, colorId] of pixelUpdates.entries()) {
        const [x, y] = coord.split(',').map(Number);
        const idx = getIndex(x, y);
        if (board[idx] !== colorId) {
            board[idx] = colorId;
            deltas.push({ x, y, c: colorId });
        }
    }
    pixelUpdates.clear();

    const tickMin = (now - lastMin > 60000);
    if (tickMin) lastMin = now;

    // IMPOT FONCIER (Vérification toutes les heures - 5% par 24h)
    // Pour la démo, on simule l'impôt de 5% du coût d'achat (5 Pix pour 100 Pix) chaque heure
    if (now - lastHour > 3600000) {
        lastHour = now;
        cadastre = cadastre.filter(zone => {
            if (zone.type === 'heritage') return true; 
            const ownerRef = usersDb[zone.owner];
            if (!ownerRef) return false;
            if (ownerRef.pix >= 5) {
                ownerRef.pix -= 5;
                return true;
            } else {
                console.log(`[IMPOTS] Faillite de ${zone.owner}, terrain supprimé.`);
                return false; // Zone supprimée du JSON, les murs restent mais deviennent publics !
            }
        });
    }

    for (let [id, state] of activePlayers.entries()) {
        const dbRef = usersDb[state.user];
        if (!dbRef) continue;
        if (tickMin && dbRef.hp < 100) { dbRef.hp++; state.hp = dbRef.hp; }
        if (now - state.lastMove > 60000 && Math.random() < 0.1 && dbRef.stamina < 100) {
            dbRef.stamina++; state.stamina = dbRef.stamina;
        }
    }

    if (Math.random() < 0.2) {
        const rx = Math.floor(Math.random() * BOARD_SIZE);
        const ry = Math.floor(Math.random() * BOARD_SIZE);
        if (board[getIndex(rx, ry)] === 0 && !isNexus(rx, ry)) pixelUpdates.set(`${rx},${ry}`, 5); 
    }

    const playersData = Array.from(activePlayers.values()).map(p => ({ u: p.user, x: p.x, y: p.y, d: p.isDriving, m: (now - p.lastMove < 150) }));
    const broadcastMsg = JSON.stringify({ type: 'tick', p: playersData, d: deltas });

    wss.clients.forEach(c => { if (c.readyState === 1) c.send(broadcastMsg); });

}, TICK_RATE);

server.listen(PORT, () => { console.log(`[SERVEUR] Pixel Planet actif (Port ${PORT})`); });

// ============================================================================
// ========================= FRONTEND (HTML / CSS / JS) =======================
// ============================================================================
const FRONTEND_HTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Pixel Planet - MMO Hardcore</title>
    <style>
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #000; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: white; user-select: none; }
        #game-canvas { display: block; width: 100%; height: 100%; cursor: crosshair; }
        #ui-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 10; display: flex; flex-direction: column; justify-content: space-between; }
        
        .top-bar { background: rgba(0,0,0,0.8); padding: 10px 20px; display: flex; justify-content: space-between; align-items: center; pointer-events: auto; border-bottom: 1px solid #333; }
        .stats-group { display: flex; gap: 20px; align-items: center; }
        .stat-bar { width: 150px; height: 15px; background: #333; border-radius: 10px; overflow: hidden; position: relative; border: 1px solid #555; }
        .stat-fill { height: 100%; transition: width 0.2s; }
        .hp-fill { background: #e74c3c; }
        .stam-fill { background: #f1c40f; }
        .stat-text { position: absolute; top: -2px; width: 100%; text-align: center; font-size: 11px; font-weight: bold; text-shadow: 1px 1px 2px black; }
        .pix-count { font-size: 18px; font-weight: bold; color: #f39c12; }
        .job-tag { background: #2980b9; padding: 4px 10px; border-radius: 5px; font-weight: bold; text-transform: uppercase; font-size: 12px; }
        
        #chat-container { position: absolute; bottom: 80px; left: 20px; width: 300px; height: 200px; background: rgba(0,0,0,0.7); border: 1px solid #444; border-radius: 10px; pointer-events: auto; display: flex; flex-direction: column; }
        #chat-messages { flex-grow: 1; overflow-y: auto; padding: 10px; font-size: 12px; }
        #chat-messages p { margin: 2px 0; }
        .chat-local { color: #bdc3c7; }
        .chat-global { color: #f39c12; font-weight: bold; }
        #chat-input-container { display: flex; padding: 5px; border-top: 1px solid #444; }
        #chat-input { flex-grow: 1; background: transparent; border: none; color: white; outline: none; font-size: 12px; }
        
        #inv-container { position: absolute; right: 20px; top: 70px; width: 220px; background: rgba(0,0,0,0.8); border: 1px solid #444; border-radius: 10px; pointer-events: auto; padding: 10px; max-height: 400px; overflow-y: auto; }
        .inv-slot { background: #222; border: 1px solid #555; padding: 5px; margin-bottom: 5px; font-size: 12px; border-radius: 5px; display: flex; justify-content: space-between; align-items: center; }
        .inv-btn { background: #27ae60; border: none; color: white; border-radius: 3px; cursor: pointer; padding: 2px 5px; font-size: 10px; }

        .bottom-bar { background: rgba(0,0,0,0.9); padding: 15px; pointer-events: auto; display: flex; justify-content: center; gap: 15px; border-top: 1px solid #333; }
        .btn { background: #34495e; color: white; border: 1px solid #555; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; transition: 0.2s; box-sizing: border-box; }
        .btn:hover:not(:disabled) { background: #2c3e50; border-color: #f39c12; }
        
        .modal { display: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(20,20,20,0.95); padding: 30px; border-radius: 15px; border: 1px solid #555; z-index: 100; pointer-events: auto; text-align: center; max-height: 80vh; overflow-y: auto; width: 350px; box-sizing: border-box; }
        .modal.show { display: block; }
        .modal input { display: block; width: 100%; margin: 15px 0; padding: 12px; background: #111; border: 1px solid #444; color: white; border-radius: 5px; box-sizing: border-box; font-size: 14px; }
        .modal h2 { margin-top: 0; color: #f39c12; border-bottom: 1px solid #444; padding-bottom: 10px; }
        .modal .btn { width: 100%; margin-bottom: 10px; }
        
        #modal-store, #modal-avatar, #modal-vault, #modal-shop { width: 600px; }
        .store-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; text-align: left; }
        .store-section { background: #111; padding: 15px; border-radius: 8px; border: 1px solid #333; max-height: 250px; overflow-y: auto;}
        .store-item { display: flex; justify-content: space-between; margin-bottom: 10px; align-items: center; font-size: 12px; border-bottom: 1px solid #222; padding-bottom: 5px; }
        
        .avatar-frames-container { display: flex; gap: 20px; justify-content: center; margin-bottom: 20px; }
        .avatar-grid-wrapper { text-align: center; }
        .avatar-grid { display: grid; grid-template-columns: repeat(5, 20px); grid-template-rows: repeat(5, 20px); gap: 1px; background: #333; border: 2px solid #555; }
        .avatar-pixel { width: 20px; height: 20px; background: transparent; cursor: pointer; }
        .avatar-pixel:hover { opacity: 0.8; }
        .palette-mini { display: flex; flex-wrap: wrap; gap: 5px; justify-content: center; margin-bottom: 15px; }
        .color-swatch-mini { width: 20px; height: 20px; border-radius: 3px; cursor: pointer; border: 1px solid #fff; }

        #notif { position: absolute; top: 70px; left: 50%; transform: translateX(-50%); padding: 10px 20px; border-radius: 20px; font-weight: bold; opacity: 0; transition: opacity 0.3s; z-index: 50; }
        #palette { display: none; position: absolute; bottom: 80px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.8); padding: 10px; border-radius: 10px; pointer-events: auto; gap: 5px; border: 1px solid #444; }
        .color-swatch { width: 25px; height: 25px; border-radius: 5px; cursor: pointer; border: 1px solid #fff; }
    </style>
</head>
<body>

    <canvas id="game-canvas"></canvas>

    <div id="ui-layer">
        <div class="top-bar">
            <div class="stats-group">
                <div class="job-tag" id="ui-job">Attente...</div>
                <div>
                    <div class="stat-bar"><div class="stat-fill hp-fill" id="ui-hp" style="width: 100%;"></div><div class="stat-text" id="ui-hp-txt">100 HP</div></div>
                    <div class="stat-bar" style="margin-top: 5px;"><div class="stat-fill stam-fill" id="ui-stam" style="width: 100%;"></div><div class="stat-text" id="ui-stam-txt">100 STAMINA</div></div>
                </div>
            </div>
            <div class="pix-count">🪙 <span id="ui-pix">0</span> Pix</div>
            <div style="display:flex; gap:10px;">
                <button class="btn" style="background:#e67e22; width:auto; margin:0;" onclick="buyLand()">Acheter Terrain (100 Pix)</button>
                <button class="btn" style="width:auto; margin:0;" onclick="openStore()">AlanStore (Système)</button>
            </div>
        </div>

        <div id="notif">Message</div>
        <div id="palette"></div>
        
        <div id="chat-container">
            <div id="chat-messages"></div>
            <div id="chat-input-container">
                <button onclick="chatMode='global'; document.getElementById('chat-input').placeholder='Global (-5 Pix)...'" style="background:transparent; border:none; color:#f39c12; cursor:pointer;">🌍</button>
                <button onclick="chatMode='local'; document.getElementById('chat-input').placeholder='Local...'" style="background:transparent; border:none; color:#bdc3c7; cursor:pointer;">🗣️</button>
                <input type="text" id="chat-input" placeholder="Local..." onkeypress="if(event.key==='Enter') sendChat()">
            </div>
        </div>

        <div id="inv-container">
            <h4 style="margin:0 0 10px 0; color:#f39c12;">Sac (Perdu si Mort/Déco)</h4>
            <div id="inv-list"></div>
        </div>

        <div class="bottom-bar">
            <button class="btn" onclick="openAvatarEditor()" style="background:#2980b9; width:auto; margin:0">🎨 Studio Avatar</button>
            <button class="btn" id="btn-interact" style="background:#8e44ad; width:auto; margin:0">Interagir (Clic Maintenu / Clic)</button>
            <button class="btn" onclick="document.getElementById('modal-nexus').classList.add('show')" style="width:auto; margin:0">Nexus (Métiers)</button>
        </div>
    </div>

    <!-- MODAL LOGIN -->
    <div class="modal show" id="modal-login">
        <h2>PIXEL PLANET</h2>
        <p>Le MMO Hardcore 512 Mo.</p>
        <input type="text" id="inp-user" placeholder="Pseudonyme (Min 3 char)">
        <input type="password" id="inp-pass" placeholder="Mot de passe">
        <button class="btn" id="btn-login" onclick="auth(false)" disabled>1. Chargement Map...</button>
        <button class="btn" id="btn-reg" onclick="auth(true)" style="background: #8e44ad;" disabled>Patientez...</button>
    </div>

    <!-- MODAL NEXUS -->
    <div class="modal" id="modal-nexus">
        <h2>NEXUS</h2>
        <p>Changez de métier.</p>
        <button class="btn" onclick="changeJob('ouvrier')">⛏️ Ouvrier</button>
        <button class="btn" onclick="changeJob('bâtisseur')">🧱 Bâtisseur</button>
        <button class="btn" onclick="changeJob('fermier')">🌾 Fermier</button>
        <button class="btn" onclick="changeJob('guerrier')">⚔️ Guerrier</button>
        <button class="btn" onclick="changeJob('vendeur')">💰 Vendeur</button>
        <button class="btn" onclick="changeJob('concessionnaire')">🏎️ Concessionnaire</button>
        <br><br>
        <button class="btn" style="background:#555" onclick="document.getElementById('modal-nexus').classList.remove('show')">Fermer</button>
    </div>

    <!-- MODAL COFFRE (VAULT) -->
    <div class="modal" id="modal-vault">
        <h2>Coffre-fort Persistant</h2>
        <p style="font-size:12px; color:#aaa;">Ce qui est ici est sauvé lors de la déconnexion.</p>
        <div class="store-grid">
            <div class="store-section">
                <h3 style="color:#e74c3c; margin-top:0">Votre Sac</h3>
                <div id="vault-inv-list"></div>
            </div>
            <div class="store-section">
                <h3 style="color:#2ecc71; margin-top:0">Contenu du Coffre</h3>
                <div id="vault-safe-list"></div>
            </div>
        </div>
        <br>
        <button class="btn" style="background:#555" onclick="document.getElementById('modal-vault').classList.remove('show')">Fermer</button>
    </div>

    <!-- MODAL MAGASIN P2P -->
    <div class="modal" id="modal-shop">
        <h2>Échoppe P2P</h2>
        <div id="shop-content"></div>
        <br>
        <button class="btn" style="background:#555" onclick="document.getElementById('modal-shop').classList.remove('show')">Fermer</button>
    </div>

    <!-- MODAL STORE -->
    <div class="modal" id="modal-store">
        <h2>AlanStore - Boutique Système</h2>
        <div class="store-grid">
            <div class="store-section">
                <h3 style="color:#3498db; margin-top:0">Catalogue (Gacha)</h3>
                <div id="sys-store-list"></div>
            </div>
            <div class="store-section">
                <h3 style="color:#e74c3c; margin-top:0">Marché de l'Occasion</h3>
                <div id="occasion-list"></div>
            </div>
        </div>
        <br>
        <button class="btn" style="background:#555" onclick="document.getElementById('modal-store').classList.remove('show')">Fermer</button>
    </div>

    <!-- MODAL AVATAR -->
    <div class="modal" id="modal-avatar">
        <h2>Studio Avatar</h2>
        <div class="palette-mini" id="avatar-palette"></div>
        <div class="avatar-frames-container">
            <div class="avatar-grid-wrapper"><div style="font-size:12px; margin-bottom:5px">Immobile</div><div class="avatar-grid" id="av-frame-0"></div></div>
            <div class="avatar-grid-wrapper"><div style="font-size:12px; margin-bottom:5px">Marche 1</div><div class="avatar-grid" id="av-frame-1"></div></div>
            <div class="avatar-grid-wrapper"><div style="font-size:12px; margin-bottom:5px">Marche 2</div><div class="avatar-grid" id="av-frame-2"></div></div>
        </div>
        <button class="btn" style="background:#27ae60" onclick="saveAvatar()">Sauvegarder l'Avatar</button>
        <button class="btn" style="background:#555" onclick="document.getElementById('modal-avatar').classList.remove('show')">Annuler</button>
    </div>

    <script>
        const canvas = document.getElementById('game-canvas');
        const ctx = canvas.getContext('2d');
        let ws;
        
        const BOARD_SIZE = 1000;
        let scale = 15; 
        let camX = 500, camY = 500;
        let myUser = null;
        let myJob = null;
        let isDriving = false;
        let selectedColorId = 20; 
        let chatMode = 'local';
        let currentShopCoord = null;
        
        let offCanvas = document.createElement('canvas');
        offCanvas.width = BOARD_SIZE; offCanvas.height = BOARD_SIZE;
        let offCtx = offCanvas.getContext('2d');
        
        let playersMap = [];
        let colorDict = {};
        let avatarsDict = {}; 
        
        let currentAvatarEdit = [Array(25).fill(255), Array(25).fill(255), Array(25).fill(255)];
        let selectedAvatarColor = 20;

        function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
        window.addEventListener('resize', resize); resize();

        function notify(msg, isError = false) {
            const el = document.getElementById('notif');
            el.innerText = msg; el.style.background = isError ? 'rgba(231, 76, 60, 0.95)' : 'rgba(46, 204, 113, 0.95)';
            el.style.opacity = 1; setTimeout(() => el.style.opacity = 0, 3000);
        }

        const wrap = (val, max) => ((val % max) + max) % max;
        function getContinuousPos(vx, vy, cx, cy) {
            let dx = (vx - wrap(cx, BOARD_SIZE)); let dy = (vy - wrap(cy, BOARD_SIZE));
            if (dx > BOARD_SIZE / 2) dx -= BOARD_SIZE; if (dx < -BOARD_SIZE / 2) dx += BOARD_SIZE;
            if (dy > BOARD_SIZE / 2) dy -= BOARD_SIZE; if (dy < -BOARD_SIZE / 2) dy += BOARD_SIZE;
            return { x: cx + dx, y: cy + dy };
        }

        function initNet() {
            const btn = document.getElementById('btn-login');
            fetch('/board.dat?t=' + new Date().getTime())
            .then(res => { if(!res.ok) throw new Error(); return res.arrayBuffer(); })
            .then(buffer => {
                const view = new Uint8Array(buffer);
                const imgData = offCtx.createImageData(BOARD_SIZE, BOARD_SIZE);
                connectSocket(view, imgData);
            }).catch(() => { btn.innerText = "Erreur Map"; });
        }

        function connectSocket(rawView, imgData) {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            ws = new WebSocket(protocol + '//' + window.location.host + '/');

            ws.onopen = () => {
                document.getElementById('btn-login').disabled = false; document.getElementById('btn-login').innerText = "Se connecter";
                document.getElementById('btn-reg').disabled = false; document.getElementById('btn-reg').innerText = "Créer un compte";
            };

            ws.onmessage = (e) => {
                const data = JSON.parse(e.data);

                if (data.type === 'auth_success') {
                    document.getElementById('modal-login').classList.remove('show');
                    myUser = document.getElementById('inp-user').value.trim();
                    colorDict = data.colors; avatarsDict = data.avatars;
                    camX = data.state.x; camY = data.state.y;
                    updateHUD(data.state); buildPalette(); buildAvatarEditorUI();
                    
                    const colorCache = new Uint32Array(256);
                    for (let key in colorDict) {
                        const hex = colorDict[key];
                        colorCache[key] = (255 << 24) | (parseInt(hex.slice(5,7),16) << 16) | (parseInt(hex.slice(3,5),16) << 8) | parseInt(hex.slice(1,3),16);
                    }
                    const buf32 = new Uint32Array(imgData.data.buffer);
                    for (let i = 0; i < rawView.length; i++) buf32[i] = colorCache[rawView[i]] || 0xFF000000;
                    offCtx.putImageData(imgData, 0, 0);
                    notify("Bienvenue !"); requestAnimationFrame(renderLoop);
                }
                else if (data.type === 'error') notify(data.msg, true);
                else if (data.type === 'sys') notify(data.msg);
                else if (data.type === 'sync_stats') { updateHUD(data); if(data.vault) renderVault(data.inv, data.vault); }
                else if (data.type === 'alanstore_res') renderAlanStore(data.occ, data.prices);
                else if (data.type === 'avatar_update') avatarsDict[data.u] = data.a;
                else if (data.type === 'open_vault') { renderVault(data.inv || [], data.vault); document.getElementById('modal-vault').classList.add('show'); }
                else if (data.type === 'manage_shop') { currentShopCoord = data.coord; renderManageShop(data.shop); document.getElementById('modal-shop').classList.add('show'); }
                else if (data.type === 'view_shop') { currentShopCoord = data.coord; renderViewShop(data.shop); document.getElementById('modal-shop').classList.add('show'); }
                else if (data.type === 'chat') {
                    const chatEl = document.getElementById('chat-messages');
                    chatEl.innerHTML += \`<p class="chat-\${data.channel}">[\${data.user}] \${data.msg}</p>\`; chatEl.scrollTop = chatEl.scrollHeight;
                }
                else if (data.type === 'tick') {
                    playersMap = data.p;
                    for (let d of data.d) { offCtx.fillStyle = colorDict[d.c] || '#000'; offCtx.fillRect(d.x, d.y, 1, 1); }
                    const me = playersMap.find(p => p.u === myUser);
                    if (me) isDriving = me.d;
                }
            };
        }

        function auth(isReg) { ws.send(JSON.stringify({ type: 'auth', user: document.getElementById('inp-user').value.trim(), pass: document.getElementById('inp-pass').value, isRegister: isReg })); }
        function sendChat() { const inp = document.getElementById('chat-input'); if (inp.value.trim() !== '') { ws.send(JSON.stringify({ type: 'chat', channel: chatMode, msg: inp.value.trim() })); inp.value = ''; } }

        function formatItemLabel(i) {
            let label = i.id.toUpperCase();
            if (i.mtype) label += \` [\${i.mtype}]\`; if (i.speed) label += \` ⚡\${i.speed}\`; if (i.dmg) label += \` ⚔️\${i.dmg}\`;
            return label;
        }

        // HUD & INVENTAIRE
        let currentInvData = [];
        function updateHUD(state) {
            if (state.job) { myJob = state.job; document.getElementById('ui-job').innerText = state.job; document.getElementById('palette').style.display = (myJob === 'bâtisseur' || myJob === 'vendeur') ? 'flex' : 'none'; }
            if (state.hp !== undefined) { document.getElementById('ui-hp').style.width = state.hp + '%'; document.getElementById('ui-hp-txt').innerText = state.hp + ' HP'; }
            if (state.stamina !== undefined) { document.getElementById('ui-stam').style.width = state.stamina + '%'; document.getElementById('ui-stam-txt').innerText = state.stamina + ' STAMINA'; }
            if (state.pix !== undefined) document.getElementById('ui-pix').innerText = state.pix;
            if (state.inv) {
                currentInvData = state.inv;
                const invList = document.getElementById('inv-list');
                invList.innerHTML = state.inv.map(i => {
                    let btn = '';
                    if (i.id === 'plante' || i.id === 'vehicule' || i.id === 'moteur') btn = \`<button class="inv-btn" onclick="useItem('\${i.id}')">Utiliser</button>\`;
                    return \`<div class="inv-slot"><span>\${formatItemLabel(i)} x\${i.qty}</span>\${btn}</div>\`;
                }).join('');
            }
        }

        // COFFRE FORT
        function renderVault(inv, vault) {
            const vi = document.getElementById('vault-inv-list');
            const vs = document.getElementById('vault-safe-list');
            vi.innerHTML = inv.map((i, idx) => \`<div class="store-item"><span>\${formatItemLabel(i)} x\${i.qty}</span><button class="inv-btn" onclick="ws.send(JSON.stringify({type:'vault_transfer', index:\${idx}, direction:'to_vault'}))">>></button></div>\`).join('');
            vs.innerHTML = vault.map((i, idx) => \`<div class="store-item"><button class="inv-btn" style="background:#e74c3c" onclick="ws.send(JSON.stringify({type:'vault_transfer', index:\${idx}, direction:'to_inv'}))"><<</button><span>\${formatItemLabel(i)} x\${i.qty}</span></div>\`).join('');
        }

        // MAGASIN P2P
        function renderManageShop(shop) {
            const container = document.getElementById('shop-content');
            let html = \`<p>Votre Échoppe</p>\`;
            if (shop.item) html += \`<div class="store-item"><span style="color:#f1c40f">\${formatItemLabel(shop.item)} x\${shop.item.qty}</span><span>Prix : \${shop.price} Pix</span></div><p style="color:#2ecc71">En attente d'un acheteur...</p>\`;
            else {
                html += \`<p>Sélectionnez un objet de votre inventaire à vendre :</p><div style="max-height:150px; overflow-y:auto; border:1px solid #333; padding:5px; margin-bottom:10px;">\`;
                html += currentInvData.map((i, idx) => \`<div class="store-item"><span>\${formatItemLabel(i)} x\${i.qty}</span><button class="inv-btn" onclick="sellItemP2P(\${idx})">Vendre</button></div>\`).join('');
                html += \`</div><input type="number" id="shop-price-input" placeholder="Prix de vente (Pix)">\`;
            }
            container.innerHTML = html;
        }
        function sellItemP2P(idx) {
            const price = document.getElementById('shop-price-input').value;
            if(price > 0) { ws.send(JSON.stringify({ type: 'shop_sell', coord: currentShopCoord, index: idx, price: price })); document.getElementById('modal-shop').classList.remove('show'); }
            else alert("Prix invalide");
        }
        function renderViewShop(shop) {
            const container = document.getElementById('shop-content');
            if (shop.item) container.innerHTML = \`<p>Échoppe de <b>\${shop.owner}</b></p><div class="store-item"><span style="color:#f1c40f">\${formatItemLabel(shop.item)} x\${shop.item.qty}</span><button class="btn" style="width:auto; padding:5px 10px; background:#2ecc71" onclick="buyItemP2P()">Acheter pour \${shop.price} Pix</button></div>\`;
            else container.innerHTML = \`<p>Échoppe de <b>\${shop.owner}</b></p><p style="color:#aaa">Rien à vendre pour le moment.</p>\`;
        }
        function buyItemP2P() { ws.send(JSON.stringify({ type: 'shop_buy', coord: currentShopCoord })); document.getElementById('modal-shop').classList.remove('show'); }

        const keys = { w:false, a:false, s:false, d:false };
        window.addEventListener('keydown', e => { if(keys[e.key.toLowerCase()] !== undefined) keys[e.key.toLowerCase()] = true; });
        window.addEventListener('keyup', e => { if(keys[e.key.toLowerCase()] !== undefined) keys[e.key.toLowerCase()] = false; });

        let isMouseDown = false;
        canvas.addEventListener('mousedown', (e) => { isMouseDown = true; handleInteract(e); });
        canvas.addEventListener('mouseup', () => { isMouseDown = false; });
        canvas.addEventListener('mousemove', (e) => { if (isMouseDown && myJob === 'bâtisseur') handleInteract(e); }); 

        function handleInteract(e) {
            if (!myUser) return;
            const cx = canvas.width / 2, cy = canvas.height / 2;
            const worldX = Math.floor(camX + (e.clientX - canvas.getBoundingClientRect().left - cx) / scale);
            const worldY = Math.floor(camY + (e.clientY - canvas.getBoundingClientRect().top - cy) / scale);

            let action = 'interact';
            if (myJob === 'ouvrier') action = 'mine';
            if (myJob === 'bâtisseur' || myJob === 'vendeur') action = 'build';
            if (myJob === 'fermier') action = (e.button === 2) ? 'harvest' : 'plant'; 
            if (myJob === 'guerrier') action = 'shoot';

            ws.send(JSON.stringify({ type: 'interact', x: wrap(worldX, BOARD_SIZE), y: wrap(worldY, BOARD_SIZE), action, colorId: selectedColorId }));
        }

        let lastTime = performance.now();
        function renderLoop(time) {
            requestAnimationFrame(renderLoop);
            const dt = (time - lastTime) / 1000;
            lastTime = time;
            if (!myUser) return;

            let baseSpeed = 10; 
            const wrappedCamX = wrap(Math.floor(camX), BOARD_SIZE);
            const wrappedCamY = wrap(Math.floor(camY), BOARD_SIZE);
            const pxData = offCtx.getImageData(wrappedCamX, wrappedCamY, 1, 1).data;
            const onRoute = (pxData[0] === 79 && pxData[1] === 79 && pxData[2] === 79); 
            
            if (isDriving) baseSpeed = onRoute ? 30 : 5;

            if (keys.w) camY -= baseSpeed * dt;
            if (keys.s) camY += baseSpeed * dt;
            if (keys.a) camX -= baseSpeed * dt;
            if (keys.d) camX += baseSpeed * dt;

            camX = wrap(camX, BOARD_SIZE); camY = wrap(camY, BOARD_SIZE);

            if (Math.random() < 0.3) ws.send(JSON.stringify({ type: 'move', x: camX, y: camY }));

            ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.save(); ctx.translate(canvas.width / 2, canvas.height / 2); ctx.scale(scale, scale); ctx.translate(-camX, -camY);
            ctx.imageSmoothingEnabled = false;
            
            const startX = Math.floor((camX - canvas.width / 2 / scale) / BOARD_SIZE) * BOARD_SIZE;
            const startY = Math.floor((camY - canvas.height / 2 / scale) / BOARD_SIZE) * BOARD_SIZE;
            
            for(let i=0; i<=1; i++) {
                for(let j=0; j<=1; j++) {
                    let bx = startX + i*BOARD_SIZE, by = startY + j*BOARD_SIZE;
                    ctx.drawImage(offCanvas, bx, by);
                    ctx.fillStyle = "rgba(0, 255, 255, 0.15)"; ctx.fillRect(bx + 475, by + 475, 50, 50);
                    ctx.strokeStyle = "rgba(0, 255, 255, 0.5)"; ctx.lineWidth = 1; ctx.strokeRect(bx + 475, by + 475, 50, 50);
                    ctx.fillStyle = "rgba(0, 255, 255, 0.9)"; ctx.font = '2.5px Arial'; ctx.textAlign = 'center';
                    ctx.fillText("NEXUS (Zone Pacifique)", bx + 500, by + 500);
                }
            }

            for (let p of playersMap) {
                const cPos = getContinuousPos(p.x, p.y, camX, camY);
                if (p.d) { 
                    ctx.fillStyle = (p.u === myUser) ? '#e67e22' : '#d35400'; ctx.fillRect(cPos.x - 7, cPos.y - 7, 15, 15); 
                } else {
                    const av = avatarsDict[p.u];
                    if (av) {
                        const frameIdx = p.m ? (Math.floor(Date.now() / 200) % 2) + 1 : 0;
                        const frameData = av[frameIdx];
                        for (let i=0; i<25; i++) {
                            if (frameData[i] === 255) continue;
                            ctx.fillStyle = colorDict[frameData[i]] || '#FFF';
                            ctx.fillRect(cPos.x - 2 + (i%5), cPos.y - 2 + Math.floor(i/5), 1, 1);
                        }
                    } else {
                        ctx.fillStyle = (p.u === myUser) ? '#f1c40f' : '#e74c3c'; ctx.fillRect(cPos.x - 2, cPos.y - 2, 5, 5);
                    }
                }
                ctx.font = '3px Arial'; ctx.textAlign = 'center';
                const textW = ctx.measureText(p.u).width;
                ctx.fillStyle = "rgba(0, 0, 0, 0.5)"; ctx.fillRect(cPos.x - textW/2 - 1, cPos.y - 7, textW + 2, 4);
                ctx.fillStyle = 'white'; ctx.fillText(p.u, cPos.x, cPos.y - 4);
            }
            ctx.restore();
        }

        function changeJob(job) { ws.send(JSON.stringify({ type: 'interact', x: camX, y: camY, action: 'change_job', job: job })); document.getElementById('modal-nexus').classList.remove('show'); }
        function buyLand() { ws.send(JSON.stringify({ type: 'buy_land' })); }
        function useItem(id) { ws.send(JSON.stringify({ type: 'use_item', item: id })); }

        function openStore() { ws.send(JSON.stringify({ type: 'alanstore_req' })); document.getElementById('modal-store').classList.add('show'); }
        function buySys(item) { ws.send(JSON.stringify({ type: 'alanstore_buy_sys', item })); }
        function buyOcc(index) { ws.send(JSON.stringify({ type: 'alanstore_buy_occ', index })); }

        function renderAlanStore(occasionData, prices) {
            const sysList = document.getElementById('sys-store-list');
            const items = [{id:'pioche',n:'Pioche'},{id:'moteur',n:'Moteur'},{id:'arme',n:'Arme'},{id:'etabli',n:'Établi'},{id:'bloc_peinture',n:'Peinture'},{id:'bloc_garage',n:'Garage'},{id:'bloc_magasin',n:'Magasin'},{id:'coffre',n:'Coffre-fort'},{id:'bloc_entreprise',n:'Entreprise'}];
            sysList.innerHTML = items.map(i => \`<div class="store-item"><span>\${i.n}</span><button class="inv-btn" onclick="buySys('\${i.id}')">\${prices[i.id]} Pix</button></div>\`).join('');
            const occList = document.getElementById('occasion-list');
            if (occasionData.length === 0) occList.innerHTML = "<p style='font-size:12px;color:#888'>Aucun butin saisi.</p>";
            else occList.innerHTML = occasionData.map((item, idx) => \`<div class="store-item" style="border-bottom:1px dashed #444"><span style="color:#f1c40f">\${formatItemLabel(item)} x\${item.qty}</span><button class="inv-btn" style="background:#8e44ad" onclick="buyOcc(\${idx})">50 Pix</button></div>\`).join('');
        }

        function buildPalette() {
            const pal = document.getElementById('palette'); pal.innerHTML = '';
            const buildable = [20, 21, 22, 23, 30, 31, 32, 2, 1, 10, 11, 12, 13, 14, 15, 16]; 
            for (let id of buildable) {
                const div = document.createElement('div');
                div.className = 'color-swatch'; div.style.backgroundColor = colorDict[id];
                div.onclick = () => { selectedColorId = id; document.querySelectorAll('.color-swatch').forEach(el => el.style.borderColor = 'white'); div.style.borderColor = '#f1c40f'; };
                pal.appendChild(div);
            }
        }

        function buildAvatarEditorUI() {
            const pal = document.getElementById('avatar-palette'); pal.innerHTML = '';
            const tDiv = document.createElement('div'); tDiv.className = 'color-swatch-mini'; tDiv.style.background = 'transparent'; tDiv.style.borderColor = '#f1c40f';
            tDiv.innerText = 'X'; tDiv.style.color = 'red'; tDiv.style.textAlign = 'center'; tDiv.style.lineHeight = '20px';
            tDiv.onclick = () => { selectedAvatarColor = 255; document.querySelectorAll('.color-swatch-mini').forEach(el => el.style.borderColor = 'white'); tDiv.style.borderColor = '#f1c40f'; };
            pal.appendChild(tDiv);
            for (let id in colorDict) {
                if (id == 0) continue; 
                const div = document.createElement('div'); div.className = 'color-swatch-mini'; div.style.backgroundColor = colorDict[id];
                div.onclick = () => { selectedAvatarColor = id; document.querySelectorAll('.color-swatch-mini').forEach(el => el.style.borderColor = 'white'); div.style.borderColor = '#f1c40f'; };
                pal.appendChild(div);
            }
            for (let f=0; f<3; f++) {
                const grid = document.getElementById(\`av-frame-\${f}\`); grid.innerHTML = '';
                for (let i=0; i<25; i++) {
                    const px = document.createElement('div'); px.className = 'avatar-pixel';
                    px.onclick = () => { currentAvatarEdit[f][i] = selectedAvatarColor; px.style.background = selectedAvatarColor === 255 ? 'transparent' : colorDict[selectedAvatarColor]; };
                    grid.appendChild(px);
                }
            }
        }

        function openAvatarEditor() {
            if (avatarsDict[myUser]) currentAvatarEdit = JSON.parse(JSON.stringify(avatarsDict[myUser]));
            for (let f=0; f<3; f++) {
                const grid = document.getElementById(\`av-frame-\${f}\`);
                for (let i=0; i<25; i++) {
                    const colId = currentAvatarEdit[f][i];
                    grid.children[i].style.background = (colId === 255) ? 'transparent' : colorDict[colId];
                }
            }
            document.getElementById('modal-avatar').classList.add('show');
        }

        function saveAvatar() { ws.send(JSON.stringify({ type: 'set_avatar', frames: currentAvatarEdit })); document.getElementById('modal-avatar').classList.remove('show'); }

        initNet();
    </script>
</body>
</html>
`;
