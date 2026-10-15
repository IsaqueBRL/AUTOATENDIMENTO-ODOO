// =====================================================================
// SEGURANÇA: CPF, tokens dos QR Codes, limite de tentativas e máscara de nomes
// =====================================================================
import crypto from "node:crypto";

// ---------- CPF ----------
export function limparCpf(v) {
    return String(v ?? "").replace(/\D/g, "");
}

export function cpfValido(cpf) {
    if (!/^\d{11}$/.test(cpf)) return false;
    if (/^(\d)\1{10}$/.test(cpf)) return false; // 11111111111 etc.
    const digito = (base) => {
        let soma = 0;
        for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (base.length + 1 - i);
        const r = (soma * 10) % 11;
        return r === 10 ? 0 : r;
    };
    return digito(cpf.slice(0, 9)) === Number(cpf[9]) && digito(cpf.slice(0, 10)) === Number(cpf[10]);
}

// 12345678909 -> 123.456.789-09 (só para procurar contatos antigos gravados com pontos e traço)
export function cpfFormatado(cpf) {
    return cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
}

// ---------- NOMES ----------
export function normalizarNome(v) {
    return String(v ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .toLocaleUpperCase("pt-BR");
}

export function nomeValido(nome) {
    if (nome.length < 3 || nome.length > 80) return false;
    // só letras (com acento), espaço, apóstrofo, ponto e hífen
    return /^[\p{L}][\p{L} .'’-]*$/u.test(nome);
}

// "ISAQUE MOISES SILVA" -> "ISAQUE M."
export function mascararNome(nome) {
    const partes = String(nome || "").trim().split(/\s+/).filter(Boolean);
    if (partes.length === 0) return "cliente";
    if (partes.length === 1) return partes[0];
    return partes[0] + " " + partes[1].charAt(0).toLocaleUpperCase("pt-BR") + ".";
}

// ---------- TOKEN DO QR CODE ----------
// O link do QR carrega um código calculado a partir do ID do armazém e de uma senha secreta (QR_SECRET).
// Ninguém consegue inventar o código de outro local sem conhecer a senha.
function segredo() {
    const s = process.env.QR_SECRET;
    if (!s || s.length < 16) throw new Error("QR_SECRET não configurado.");
    return s;
}

export function tokenDoArmazem(armazemId) {
    return crypto.createHmac("sha256", segredo()).update("armazem:" + Number(armazemId)).digest("base64url").slice(0, 16);
}

export function tokenConfere(tokenRecebido, armazemId) {
    const a = Buffer.from(String(tokenRecebido || ""));
    const b = Buffer.from(tokenDoArmazem(armazemId));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function tokenComFormatoValido(t) {
    return typeof t === "string" && /^[A-Za-z0-9_-]{16}$/.test(t);
}

// ---------- LIMITE DE TENTATIVAS ----------
// Guardado na memória do servidor: segura abusos simples; não é um limite global perfeito.
const tentativas = new Map();
export function limitar(chave, max, janelaMs) {
    const agora = Date.now();
    const lista = (tentativas.get(chave) || []).filter(t => agora - t < janelaMs);
    if (lista.length >= max) {
        tentativas.set(chave, lista);
        return false;
    }
    lista.push(agora);
    tentativas.set(chave, lista);
    if (tentativas.size > 5000) { // limpeza para não crescer sem fim
        for (const [k, v] of tentativas) if (!v.length || agora - v[v.length - 1] > janelaMs) tentativas.delete(k);
    }
    return true;
}

export function ipDoCliente(req) {
    const h = req.headers || {};
    const bruto = h["x-vercel-forwarded-for"] || h["x-forwarded-for"] || h["x-real-ip"] || (req.socket && req.socket.remoteAddress) || "desconhecido";
    return String(bruto).split(",")[0].trim();
}

// ---------- LOG SEM DADOS PESSOAIS ----------
export function semCpf(texto) {
    return String(texto ?? "").replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, "[cpf]");
}
