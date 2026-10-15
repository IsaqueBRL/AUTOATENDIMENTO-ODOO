// =====================================================================
// CONEXÃO COM O ODOO
// =====================================================================
// As credenciais vêm SOMENTE das variáveis de ambiente da Vercel:
//   ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY
// Nada de senha ou chave escrita no código.

const faltando = ["ODOO_URL", "ODOO_DB", "ODOO_USER", "ODOO_API_KEY"].filter(k => !process.env[k]);

function urlDoOdoo() {
    const base = String(process.env.ODOO_URL || "").trim().replace(/\/+$/, "");
    // aceita tanto "https://empresa.odoo.com" quanto "https://empresa.odoo.com/jsonrpc"
    return /\/jsonrpc$/.test(base) ? base : base + "/jsonrpc";
}

const READ_METHODS = new Set(["search_read", "read", "fields_get", "search", "search_count", "read_group", "name_search"]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let cachedUid = null;
let uidPromise = null;

async function rpc(service, method, args, tentativa = 0) {
    if (faltando.length) {
        console.error("Variáveis de ambiente ausentes:", faltando.join(", "));
        throw new Error("Servidor não configurado.");
    }
    const leitura = service === "common" || (service === "object" && READ_METHODS.has(args && args[4]));
    let status = 0, text = "";
    try {
        const r = await fetch(urlDoOdoo(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
            // sem limite, uma chamada pendurada seguraria a função até a Vercel derrubá-la
            signal: AbortSignal.timeout(20000)
        });
        status = r.status;
        text = await r.text();
    } catch (e) {
        if (leitura && tentativa < 2) { await sleep(500 * (tentativa + 1)); return rpc(service, method, args, tentativa + 1); }
        throw new Error("Não foi possível conectar ao Odoo.");
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        if (leitura && tentativa < 2) { await sleep(500 * (tentativa + 1)); return rpc(service, method, args, tentativa + 1); }
        throw new Error("O Odoo respondeu com uma página de erro (HTTP " + status + ").");
    }
}

// Faz o login UMA vez e reaproveita o uid nas chamadas seguintes
function getUid() {
    if (cachedUid) return Promise.resolve(cachedUid);
    if (!uidPromise) {
        uidPromise = rpc("common", "authenticate", [process.env.ODOO_DB, process.env.ODOO_USER, process.env.ODOO_API_KEY, {}])
            .then(d => {
                if (!d.result) throw new Error("Falha na autenticação com o Odoo.");
                cachedUid = d.result;
                return cachedUid;
            })
            .finally(() => { uidPromise = null; });
    }
    return uidPromise;
}

async function execute(model, method, args, kwargs = {}) {
    const uid = await getUid();
    const d = await rpc("object", "execute_kw", [process.env.ODOO_DB, uid, process.env.ODOO_API_KEY, model, method, args, kwargs]);
    if (d.error) {
        const errData = d.error.data || {};
        const msg = errData.message || errData.debug || d.error.message || ("Erro do Odoo em " + model + "." + method);
        throw new Error(msg);
    }
    return d.result;
}

// Cache em memória (vale enquanto o servidor estiver "quente")
const _cache = new Map();
function cached(key, ttlMs, fn) {
    const hit = _cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.p;
    const p = fn().catch(err => { _cache.delete(key); throw err; });
    _cache.set(key, { p, exp: Date.now() + ttlMs });
    return p;
}

function invalidar(chave) {
    _cache.delete(chave);
}

// Remove de um objeto os campos que não existem naquele modelo (evita "Invalid field" entre versões do Odoo)
async function onlyExistingFields(model, vals) {
    try {
        const defs = await cached("fields_" + model, 10 * 60 * 1000, () => execute(model, "fields_get", [], { attributes: ["type"] }));
        const out = {};
        for (const k of Object.keys(vals)) {
            if (vals[k] === undefined) continue;
            if (defs && defs[k]) out[k] = vals[k];
        }
        return out;
    } catch (e) {
        return vals;
    }
}

export { execute, cached, invalidar, onlyExistingFields };
