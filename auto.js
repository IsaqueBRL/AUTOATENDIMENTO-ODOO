// =====================================================================
// API DO AUTOATENDIMENTO
// =====================================================================
// Única porta de entrada do site do cliente. Só faz o que o autoatendimento precisa:
//   local        -> nome do local do QR Code (e chave Pix, se houver)
//   produtos     -> produtos com estoque no local
//   cpf_buscar   -> o CPF já tem cadastro? (devolve o nome MASCARADO)
//   cliente_criar-> cadastra cliente novo só com nome + CPF
//   pedido_criar -> cria o pedido no Odoo (venda confirmada + entrega + fatura em rascunho)
// Preço e estoque SEMPRE vêm do Odoo; o navegador só manda "produto e quantidade".
// Nenhuma ação de excluir, ajustar estoque ou lançar pagamento existe aqui.

import { execute, cached, invalidar, onlyExistingFields } from "../lib/odoo.js";
import {
    limparCpf, cpfValido, cpfFormatado, normalizarNome, nomeValido, mascararNome,
    tokenConfere, tokenComFormatoValido, limitar, ipDoCliente, semCpf
} from "../lib/seguranca.js";

export const config = { maxDuration: 30 };

// ---------- configurações (todas opcionais; valores padrão abaixo) ----------
const TAG_PAGAR_DEPOIS = process.env.TAG_PAGAR_DEPOIS || "Autoatendimento: pagar depois";
const MAX_DIAS_VENCIMENTO = Number(process.env.MAX_DIAS_VENCIMENTO) || 30;
const CONTA_FATURA = process.env.FORCED_INVOICE_ACCOUNT_CODE || "3.01.01.01.01.04"; // mesma conta que o painel força nas faturas
const FUSO = process.env.FUSO_HORARIO || "America/Manaus";
const PIX_ENV = (process.env.PIX_CHAVE || "").trim();
// A chave Pix é definida no painel (tela QR CODES) e guardada no Odoo; a variável PIX_CHAVE serve só de reserva.
async function pixChave() {
    try {
        const v = await cached("pix_chave", 60 * 1000, () => execute("ir.config_parameter", "get_param", ["deuris.autoatendimento_pix"]));
        const t = String(v || "").trim();
        if (t) return t;
    } catch (e) { /* usa a reserva */ }
    return PIX_ENV;
}

class ErroPublico extends Error {
    constructor(msg, status = 400) { super(msg); this.publico = true; this.status = status; }
}

// ---------- datas ----------
function hojeISO() {
    return new Date().toLocaleDateString("sv-SE", { timeZone: FUSO }); // AAAA-MM-DD
}
function somarDias(iso, dias) {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
}
function dataBR(iso) {
    const [a, m, d] = iso.split("-");
    return d + "/" + m + "/" + a;
}

const semAcento = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

// ---------- armazéns / locais ----------
const armazens = () => cached("armazens", 3 * 60 * 1000, () =>
    execute("stock.warehouse", "search_read", [[]], { fields: ["id", "name", "code", "lot_stock_id", "view_location_id"] }));

async function armazemPorToken(token) {
    if (!tokenComFormatoValido(token)) throw new ErroPublico("QR Code inválido. Escaneie o QR Code do local novamente.", 404);
    const lista = await armazens();
    const wh = (lista || []).find(w => tokenConfere(token, w.id));
    if (!wh) throw new ErroPublico("QR Code inválido ou desativado. Escaneie o QR Code do local novamente.", 404);
    return wh;
}

// Estoque DISPONÍVEL (em mãos menos reservado) por produto, somando o local de estoque do armazém e sublocais
async function estoqueDoArmazem(wh, produtoIds) {
    const raiz = Array.isArray(wh.lot_stock_id) ? wh.lot_stock_id[0] : wh.view_location_id[0];
    const dominio = [["location_id", "child_of", raiz], ["location_id.usage", "=", "internal"], ["quantity", ">", 0]];
    if (produtoIds) dominio.push(["product_id", "in", produtoIds]);
    let quants;
    try {
        quants = await execute("stock.quant", "search_read", [dominio], { fields: ["product_id", "quantity", "reserved_quantity"], limit: 10000 });
    } catch (e) {
        quants = await execute("stock.quant", "search_read", [dominio], { fields: ["product_id", "quantity"], limit: 10000 });
    }
    const mapa = {};
    (quants || []).forEach(q => {
        if (!Array.isArray(q.product_id)) return;
        const livre = (q.quantity || 0) - (q.reserved_quantity || 0);
        mapa[q.product_id[0]] = (mapa[q.product_id[0]] || 0) + livre;
    });
    return mapa;
}

const limparNomeProduto = (n) => String(n || "").replace(/^\[[^\]]*\]\s*/, "").trim();

async function listarProdutos(wh) {
    return cached("produtos_" + wh.id, 15 * 1000, async () => {
        const estoque = await estoqueDoArmazem(wh, null);
        const ids = Object.keys(estoque).map(Number).filter(id => Math.floor(estoque[id] + 1e-9) >= 1);
        if (ids.length === 0) return [];
        const produtos = await execute("product.product", "search_read", [[["id", "in", ids], ["sale_ok", "=", true]]], {
            fields: ["id", "display_name", "list_price"]
        });
        return (produtos || [])
            .map(p => ({
                id: p.id,
                nome: limparNomeProduto(p.display_name),
                preco: Number(p.list_price) || 0,
                estoque: Math.floor(estoque[p.id] + 1e-9)
            }))
            .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    });
}

// ---------- clientes (CPF) ----------
async function parceiroPorCpf(cpf) {
    const r = await execute("res.partner", "search_read", [["|", ["vat", "=", cpf], ["vat", "=", cpfFormatado(cpf)]]], {
        fields: ["id", "name", "category_id"], order: "id asc", limit: 1
    });
    return (r && r[0]) || null;
}

// Só quem foi liberado no Odoo (marcador no contato) pode pagar depois
async function podePagarDepois(parceiro) {
    const ids = Array.isArray(parceiro.category_id) ? parceiro.category_id : [];
    if (ids.length === 0) return false;
    const cats = await execute("res.partner.category", "read", [ids], { fields: ["name"] });
    const alvo = semAcento(TAG_PAGAR_DEPOIS);
    return (cats || []).some(c => semAcento(c.name) === alvo);
}

async function tipoIdentificacaoCpf() {
    return cached("tipo_cpf", 10 * 60 * 1000, async () => {
        try {
            const r = await execute("l10n_latam.identification.type", "search_read", [[["name", "=", "CPF"]]], { fields: ["id"], limit: 1 });
            return (r && r[0] && r[0].id) || null;
        } catch (e) {
            return null; // sem o módulo de tipos de documento: grava só o número
        }
    });
}

async function criarParceiro(cpf, nome) {
    const tipoId = await tipoIdentificacaoCpf();
    const vals = await onlyExistingFields("res.partner", {
        name: nome,
        vat: cpf, // sempre só números, no padrão do Odoo
        customer_rank: 1,
        company_type: "person",
        l10n_latam_identification_type_id: tipoId || undefined
    });
    const id = await execute("res.partner", "create", [vals]);
    return { id, name: nome, category_id: [] };
}

// ---------- pedido ----------
async function resolverContaFatura() {
    return cached("conta_fatura", 10 * 60 * 1000, async () => {
        const r = await execute("account.account", "search_read", [[["code", "=", CONTA_FATURA]]], { fields: ["id"], limit: 1 });
        return (r && r[0] && r[0].id) || null;
    });
}

async function aplicarContaNaFatura(invoiceId) {
    const contaId = await resolverContaFatura();
    if (!contaId) return;
    const linhas = await execute("account.move.line", "search_read", [[["move_id", "=", invoiceId], ["display_type", "=", "product"], ["account_id", "!=", contaId]]], { fields: ["id"] });
    const ids = (linhas || []).map(l => l.id);
    if (ids.length) await execute("account.move.line", "write", [ids, { account_id: contaId }]);
}

async function criarFatura(orderId) {
    const ctx = { active_model: "sale.order", active_id: orderId, active_ids: [orderId] };
    const antes = await execute("sale.order", "read", [[orderId]], { fields: ["invoice_ids"] });
    const idsAntes = (antes && antes[0] && antes[0].invoice_ids) || [];
    const wiz = await execute("sale.advance.payment.inv", "create", [{ advance_payment_method: "delivered" }], { context: ctx });
    await execute("sale.advance.payment.inv", "create_invoices", [[wiz]], { context: ctx });
    const depois = await execute("sale.order", "read", [[orderId]], { fields: ["invoice_ids"] });
    const idsDepois = (depois && depois[0] && depois[0].invoice_ids) || [];
    return idsDepois.filter(id => !idsAntes.includes(id));
}

async function validarEntrega(pickingId) {
    const vr = await execute("stock.picking", "button_validate", [[pickingId]], { context: { skip_sms: true } });
    if (vr && typeof vr === "object" && vr.res_model) {
        const wctx = Object.assign({}, vr.context || {}, { skip_sms: true });
        const wid = await execute(vr.res_model, "create", [{}], { context: wctx });
        const metodo = vr.res_model === "stock.backorder.confirmation" ? "process_cancel_backorder" : "process";
        await execute(vr.res_model, metodo, [[wid]], { context: wctx });
    }
    const chk = await execute("stock.picking", "read", [[pickingId]], { fields: ["state"] });
    if (!chk || !chk[0] || chk[0].state !== "done") throw new Error("entrega não concluída");
}

async function baixarEstoqueDoPedido(orderId) {
    const entregas = await execute("stock.picking", "search_read", [[["sale_id", "=", orderId], ["state", "not in", ["done", "cancel"]]]], { fields: ["id"] });
    if (!entregas || entregas.length === 0) throw new Error("nenhuma entrega gerada");
    for (const p of entregas) {
        const moves = await execute("stock.move", "search_read", [[["picking_id", "=", p.id]]], { fields: ["id", "product_uom_qty"] });
        for (const mv of (moves || [])) {
            try {
                await execute("stock.move", "write", [[mv.id], { quantity: mv.product_uom_qty }]);
            } catch (e) {
                await execute("stock.move", "write", [[mv.id], { quantity_done: mv.product_uom_qty }]);
            }
        }
        await validarEntrega(p.id);
    }
}

// Deixa entrega e pedido destravados, como o painel faz enquanto a fatura não está paga
async function destravar(orderId) {
    const entregas = await execute("stock.picking", "search_read", [[["sale_id", "=", orderId], ["state", "=", "done"], ["picking_type_code", "=", "outgoing"]]], { fields: ["id", "is_locked"] });
    for (const e of (entregas || [])) {
        if (!e.is_locked) continue;
        try { await execute("stock.picking", "write", [[e.id], { is_locked: false }]); }
        catch (err) { await execute("stock.picking", "action_toggle_is_locked", [[e.id]]); }
    }
    try {
        const r = await execute("sale.order", "read", [[orderId]], { fields: ["locked"] });
        if (r && r[0] && r[0].locked) await execute("sale.order", "write", [[orderId], { locked: false }]);
    } catch (e) { /* Odoo mais antigo: sem o campo locked */ }
}

async function desfazerPedido(orderId) {
    try { await execute("sale.order", "action_cancel", [[orderId]]); } catch (e) { /* melhor esforço */ }
}

// Um pedido por vez em cada local (dentro deste servidor), para dois clientes não levarem a mesma última unidade
const filas = new Map();
function serializar(chave, fn) {
    const anterior = filas.get(chave) || Promise.resolve();
    const proxima = anterior.catch(() => {}).then(fn);
    filas.set(chave, proxima);
    proxima.finally(() => { if (filas.get(chave) === proxima) filas.delete(chave); }).catch(() => {});
    return proxima;
}

// Mesmo pedido enviado duas vezes (duplo toque, internet que caiu e voltou) devolve o primeiro resultado
const pedidosRecentes = new Map();

function lerItens(brutos) {
    if (!Array.isArray(brutos) || brutos.length === 0) throw new ErroPublico("Seu carrinho está vazio.");
    if (brutos.length > 40) throw new ErroPublico("Itens demais no pedido.");
    const mapa = new Map();
    for (const it of brutos) {
        const id = Number(it && it.id);
        const qtd = Number(it && it.qtd);
        if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(qtd) || qtd < 1 || qtd > 999) throw new ErroPublico("Quantidade inválida no pedido.");
        mapa.set(id, (mapa.get(id) || 0) + qtd);
    }
    return [...mapa.entries()].map(([id, qtd]) => ({ id, qtd }));
}

async function criarPedido({ wh, parceiro, itens, forma, vencimento }) {
    const ids = itens.map(i => i.id);

    // preço e disponibilidade conferidos AGORA, direto no Odoo
    const [produtos, estoque] = await Promise.all([
        execute("product.product", "search_read", [[["id", "in", ids], ["sale_ok", "=", true]]], { fields: ["id", "display_name", "list_price"] }),
        estoqueDoArmazem(wh, ids)
    ]);
    const porId = new Map((produtos || []).map(p => [p.id, p]));
    const problemas = [];
    for (const it of itens) {
        const p = porId.get(it.id);
        if (!p) { problemas.push("Um dos produtos não está mais à venda."); continue; }
        const livre = Math.floor((estoque[it.id] || 0) + 1e-9);
        if (it.qtd > livre) {
            const nome = limparNomeProduto(p.display_name);
            problemas.push(livre <= 0 ? nome + " acabou." : "Só há " + livre + " de " + nome + ".");
        }
    }
    if (problemas.length) {
        throw new ErroPublico("Estoque mudou: " + [...new Set(problemas)].join(" ") + " Atualize seu carrinho.", 409);
    }

    const rotulo = forma === "pix" ? "Pix (aguardando confirmação)"
        : forma === "especie" ? "Dinheiro em espécie (aguardando confirmação)"
        : "Pagar depois, vencimento " + dataBR(vencimento);

    const base = {
        partner_id: parceiro.id,
        warehouse_id: wh.id,
        payment_term_id: false,
        validity_date: vencimento,
        note: "Autoatendimento · " + wh.name + " · " + rotulo,
        client_order_ref: "AUTOATENDIMENTO",
        order_line: itens.map(it => [0, 0, {
            product_id: it.id,
            product_uom_qty: it.qtd,
            price_unit: Number(porId.get(it.id).list_price) || 0,
            discount: 0
        }])
    };
    const vals = await onlyExistingFields("sale.order", base);
    const orderId = await execute("sale.order", "create", [vals]);

    try {
        await execute("sale.order", "action_confirm", [[orderId]]);
        await baixarEstoqueDoPedido(orderId);
    } catch (e) {
        console.error("Falha ao confirmar/baixar estoque do pedido", orderId, semCpf(e.message));
        await desfazerPedido(orderId);
        throw new ErroPublico("Não foi possível concluir o pedido agora. Nada foi cobrado. Tente novamente ou fale com o responsável.", 502);
    }

    // o que vem depois não desfaz o pedido: no pior caso o responsável gera a fatura pelo painel
    try { await destravar(orderId); } catch (e) { console.error("destravar", orderId, semCpf(e.message)); }
    try {
        const faturas = await criarFatura(orderId);
        if (faturas.length) {
            await aplicarContaNaFatura(faturas[0]);
            await execute("account.move", "write", [[faturas[0]], { invoice_date_due: vencimento }]);
        }
    } catch (e) {
        console.error("fatura do pedido", orderId, semCpf(e.message));
    }

    const ped = await execute("sale.order", "read", [[orderId]], { fields: ["name", "amount_total"] });
    return { ok: true, numero: (ped && ped[0] && ped[0].name) || String(orderId), total: (ped && ped[0] && ped[0].amount_total) || 0, forma, vencimento };
}

// ---------- entrada ----------
const JANELA = 10 * 60 * 1000;

export default async function handler(req, res) {
    // mesma origem: sem CORS aberto. Só POST.
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido." });

    let body;
    try {
        body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    } catch (e) {
        return res.status(400).json({ error: "Requisição inválida." });
    }
    const acao = String(body.action || "");
    const ip = ipDoCliente(req);

    const barrar = (tipo, max) => {
        if (!limitar(tipo + ":" + ip, max, JANELA)) throw new ErroPublico("Muitas tentativas. Aguarde alguns minutos e tente de novo.", 429);
    };

    try {
        barrar("geral", 200);
        const wh = await armazemPorToken(body.token);

        if (acao === "local") {
            return res.status(200).json({ ok: true, local: wh.name, pix_chave: (await pixChave()) || null, max_dias_vencimento: MAX_DIAS_VENCIMENTO });
        }

        if (acao === "produtos") {
            return res.status(200).json({ ok: true, produtos: await listarProdutos(wh) });
        }

        if (acao === "cpf_buscar") {
            barrar("cpf", 15);
            const cpf = limparCpf(body.cpf);
            if (!cpfValido(cpf)) throw new ErroPublico("CPF inválido. Confira os 11 números.");
            const p = await parceiroPorCpf(cpf);
            if (!p) return res.status(200).json({ ok: true, existe: false });
            return res.status(200).json({ ok: true, existe: true, nome_mascarado: mascararNome(p.name), pode_pagar_depois: await podePagarDepois(p) });
        }

        if (acao === "cliente_criar") {
            barrar("cadastro", 5);
            const cpf = limparCpf(body.cpf);
            if (!cpfValido(cpf)) throw new ErroPublico("CPF inválido. Confira os 11 números.");
            const nome = normalizarNome(body.nome);
            if (!nomeValido(nome)) throw new ErroPublico("Digite seu nome (apenas letras).");
            const jaExiste = await parceiroPorCpf(cpf);
            if (jaExiste) return res.status(200).json({ ok: true, existe: true, nome_mascarado: mascararNome(jaExiste.name), pode_pagar_depois: await podePagarDepois(jaExiste) });
            try {
                await criarParceiro(cpf, nome);
            } catch (e) {
                console.error("criar cliente:", semCpf(e.message));
                throw new ErroPublico("Não foi possível fazer seu cadastro agora. Fale com o responsável.", 502);
            }
            return res.status(200).json({ ok: true, existe: true, nome_mascarado: mascararNome(nome), pode_pagar_depois: false });
        }

        if (acao === "pedido_criar") {
            barrar("pedido", 8);
            const cpf = limparCpf(body.cpf);
            if (!cpfValido(cpf)) throw new ErroPublico("CPF inválido. Confira os 11 números.");
            if (!limitar("pedido-cpf:" + cpf, 20, 60 * 60 * 1000)) throw new ErroPublico("Muitos pedidos seguidos. Aguarde um pouco.", 429);

            const requestId = String(body.request_id || "");
            if (!/^[A-Za-z0-9-]{16,64}$/.test(requestId)) throw new ErroPublico("Requisição inválida.");

            const forma = String(body.forma || "");
            if (!["pix", "especie", "depois"].includes(forma)) throw new ErroPublico("Escolha a forma de pagamento.");
            if (forma === "pix" && !(await pixChave())) throw new ErroPublico("Pix indisponível neste momento. Escolha outra forma.");

            const itens = lerItens(body.itens);

            const hoje = hojeISO();
            let vencimento = hoje;
            if (forma === "depois") {
                vencimento = String(body.vencimento || "");
                if (!/^\d{4}-\d{2}-\d{2}$/.test(vencimento) || vencimento < hoje || vencimento > somarDias(hoje, MAX_DIAS_VENCIMENTO)) {
                    throw new ErroPublico("Escolha uma data de pagamento de hoje até " + dataBR(somarDias(hoje, MAX_DIAS_VENCIMENTO)) + ".");
                }
            }

            const chaveIdem = requestId + ":" + cpf;
            const anterior = pedidosRecentes.get(chaveIdem);
            if (anterior && anterior.exp > Date.now()) {
                return res.status(200).json(await anterior.promise);
            }

            const promessa = serializar("wh" + wh.id, async () => {
                const parceiro = await parceiroPorCpf(cpf);
                if (!parceiro) throw new ErroPublico("Cadastro não encontrado. Informe seu CPF novamente.", 404);
                if (forma === "depois" && !(await podePagarDepois(parceiro))) {
                    throw new ErroPublico("Pagar depois não está liberado para o seu cadastro. Escolha Pix ou dinheiro.", 403);
                }
                const r = await criarPedido({ wh, parceiro, itens, forma, vencimento });
                invalidar("produtos_" + wh.id); // o estoque mudou: a próxima lista de produtos precisa ser nova
                return r;
            });
            if (pedidosRecentes.size > 500) {
                for (const [k, v] of pedidosRecentes) if (v.exp < Date.now()) pedidosRecentes.delete(k);
            }
            pedidosRecentes.set(chaveIdem, { promise: promessa, exp: Date.now() + 10 * 60 * 1000 });
            promessa.catch(() => pedidosRecentes.delete(chaveIdem));
            return res.status(200).json(await promessa);
        }

        return res.status(400).json({ error: "Ação desconhecida." });
    } catch (e) {
        if (e && e.publico) return res.status(e.status || 400).json({ ok: false, error: e.message });
        console.error("Erro no autoatendimento:", semCpf(e && e.message));
        return res.status(500).json({ ok: false, error: "Algo deu errado. Tente novamente em instantes." });
    }
}
