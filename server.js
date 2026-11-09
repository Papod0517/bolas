const { TikTokLiveConnection } = require('tiktok-live-connector');
const { Server } = require('socket.io');

const io = new Server(3000, { cors: { origin: "*" } });

const tiktokUsername = "glotonito2";

// userId -> Promise<dataURI | null>
const cacheAvatares = new Map();

function extraerUsuario(data) {
    const u = data.user || data;
    const uniqueId = u.uniqueId || data.uniqueId || null;
    const nickname = u.nickname || data.nickname || null;

    const urls = [];
    const pp = u.profilePicture;
    if (Array.isArray(pp?.url)) urls.push(...pp.url);
    if (Array.isArray(pp?.urls)) urls.push(...pp.urls);
    if (typeof u.profilePictureUrl === 'string') urls.push(u.profilePictureUrl);
    if (typeof data.profilePictureUrl === 'string') urls.push(data.profilePictureUrl);
    for (const k of ['avatarThumb', 'avatarMedium', 'avatarLarger']) {
        if (Array.isArray(u[k]?.urlList)) urls.push(...u[k].urlList);
        if (Array.isArray(u[k]?.url)) urls.push(...u[k].url);
    }

    // El navegador no puede decodificar .heic: nos quedamos con una URL usable
    const urlValida = urls.find(x => typeof x === 'string' && !/\.heic(\?|$)/i.test(x)) || null;

    return { uniqueId, nickname, avatarUrl: urlValida };
}

async function descargarAvatar(url) {
    try {
        const res = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.tiktok.com/" }
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const tipo = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
        const buffer = Buffer.from(await res.arrayBuffer());
        return `data:${tipo};base64,${buffer.toString("base64")}`;
    } catch (e) {
        console.log(`[Avatar] No se pudo descargar: ${e.message}`);
        return null;
    }
}

function obtenerAvatar(userId, url) {
    if (!url) return Promise.resolve(null);
    if (!cacheAvatares.has(userId)) {
        cacheAvatares.set(userId, descargarAvatar(url));
    }
    return cacheAvatares.get(userId);
}

async function emitirEvento(data, vida) {
    const { uniqueId, nickname, avatarUrl } = extraerUsuario(data);
    const userId = uniqueId || nickname || "Anónimo";
    const avatar = await obtenerAvatar(userId, avatarUrl);

    if (!avatar) {
        // Si falla, reintenta la próxima vez en vez de cachear el fallo
        cacheAvatares.delete(userId);
        console.log(`[Avatar] Sin avatar para ${userId} (url: ${avatarUrl})`);
    }

    io.emit("nuevo_evento", { vida, avatarUrl: avatar, userId });
}

function iniciarConexion() {
    console.log(`[TikTok] Intentando conectar al directo de @${tiktokUsername}...`);

    const conn = new TikTokLiveConnection(tiktokUsername, {});

    conn.connect().then(state => {
        console.log(`[TikTok] ¡Conectado con éxito al directo! (RoomId: ${state.roomId})`);
    }).catch(() => {
        console.log(`[TikTok] El usuario no está en directo o hubo un error. Reintentando en 3 segundos...`);
        setTimeout(iniciarConexion, 3000);
    });

    conn.on('disconnected', () => {
        console.log("[TikTok] Se perdió la conexión con el directo. Reintentando en 3 segundos...");
        setTimeout(iniciarConexion, 3000);
    });

    conn.on('like', data => {
        const { nickname, uniqueId } = extraerUsuario(data);
        console.log(`¡Like de ${nickname || uniqueId || "Anónimo"}!`);
        emitirEvento(data, 10.0);
    });

    conn.on('gift', data => {
        if (data.giftType === 1 && !data.repeatEnd) return; // racha en curso

        const { nickname, uniqueId } = extraerUsuario(data);
        const diamantes = data.giftDetails?.diamondCount ?? data.diamondCount ?? 1;
        const monedas = diamantes * (data.repeatCount || 1);
        const vidaRegalo = monedas >= 100 ? 300 : (monedas >= 10 ? 200 : 100);

        console.log(`¡Regalo de ${nickname || uniqueId}: ${monedas} monedas!`);
        emitirEvento(data, Math.max(99.0, vidaRegalo));
    });

    // Evento Follow (Nuevos seguidores)
    conn.on('follow', data => {
        const { nickname, uniqueId } = extraerUsuario(data);
        console.log(`¡Nuevo seguidor: ${nickname || uniqueId || "Anónimo"}!`);
        emitirEvento(data, 20.0);
    });
}

iniciarConexion();