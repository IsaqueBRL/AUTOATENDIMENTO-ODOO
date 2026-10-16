// Service worker simples: guarda só os arquivos do app (visual). NUNCA guarda respostas da API.
const VERSAO = "ad-v2";
const ARQUIVOS = ["/index.html", "/style.css", "/app.js", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
    e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches.keys().then(chaves => Promise.all(chaves.filter(k => k !== VERSAO).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (e) => {
    const req = e.request;
    const url = new URL(req.url);
    if (req.method !== "GET" || url.origin !== location.origin) return;
    if (url.pathname.startsWith("/api/")) return; // dados sempre da rede

    // páginas: rede primeiro (pega atualizações); sem internet, mostra a última cópia
    if (req.mode === "navigate") {
        e.respondWith(fetch(req).catch(() => caches.match("/index.html")));
        return;
    }
    // arquivos do app: cópia guardada, atualizada em segundo plano
    e.respondWith(
        caches.match(req).then(guardado => {
            const rede = fetch(req).then(r => {
                if (r && r.ok) { const copia = r.clone(); caches.open(VERSAO).then(c => c.put(req, copia)); }
                return r;
            }).catch(() => guardado);
            return guardado || rede;
        })
    );
});
