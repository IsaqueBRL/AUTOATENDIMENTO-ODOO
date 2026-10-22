// Service worker: guarda só os arquivos do app (visual). NUNCA guarda respostas da API.
// Rede primeiro (com limite de 4 s) para HTML, JS e CSS: assim a página, o script e o estilo sempre são da MESMA versão.
// Antes, o script vinha do cache e a página da rede, e depois de uma atualização o app podia quebrar por uma abertura.
const VERSAO = "ad-v4";
const ARQUIVOS = ["/index.html", "/style.css", "/app.js", "/icon-192.png", "/icon-512.png"];
const TEMPO_REDE_MS = 4000;

self.addEventListener("install", (e) => {
    e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches.keys().then(chaves => Promise.all(chaves.filter(k => k !== VERSAO).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

async function redeComLimite(req) {
    const rede = fetch(req).then(r => {
        if (r && r.status === 200 && r.type === "basic") {
            const copia = r.clone();
            caches.open(VERSAO).then(c => c.put(req, copia)).catch(() => {});
        }
        return r;
    });
    return Promise.race([
        rede,
        new Promise((_, falha) => setTimeout(() => falha(new Error("lento")), TEMPO_REDE_MS))
    ]).catch(async (erro) => {
        const guardado = await caches.match(req);
        if (guardado) { rede.catch(() => {}); return guardado; }
        return rede;            // sem cópia guardada: espera a rede mesmo assim
    });
}

self.addEventListener("fetch", (e) => {
    const req = e.request;
    const url = new URL(req.url);
    if (req.method !== "GET" || url.origin !== location.origin) return;
    if (url.pathname.startsWith("/api/")) return; // dados sempre da rede

    // páginas: rede primeiro; sem internet, mostra a última cópia da página
    if (req.mode === "navigate") {
        e.respondWith(redeComLimite(req).catch(() => caches.match("/index.html")));
        return;
    }
    // ícones: cópia guardada (quase nunca mudam)
    if (/\.png$/.test(url.pathname)) {
        e.respondWith(caches.match(req).then(g => g || fetch(req)));
        return;
    }
    // app.js, style.css e o resto: rede primeiro, cópia guardada só se a rede falhar ou demorar
    e.respondWith(redeComLimite(req));
});
