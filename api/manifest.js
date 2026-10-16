// Manifesto do app instalável. O endereço de abertura inclui o código do QR (?l=...), então o app
// instalado a partir de um QR sempre abre direto no local certo.
import { tokenComFormatoValido } from "../lib/seguranca.js";

export default function handler(req, res) {
    const t = String((req.query && req.query.l) || "");
    const inicio = tokenComFormatoValido(t) ? "/?l=" + t : "/";
    res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(200).send(JSON.stringify({
        id: inicio,
        name: "Autoatendimento Deuris Candy",
        short_name: "Autoatendimento",
        description: "Escolha seus produtos e pague na hora ou depois.",
        start_url: inicio,
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#f4f7f6",
        theme_color: "#7d3c98",
        lang: "pt-BR",
        icons: [
            { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
    }));
}
