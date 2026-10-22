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
    const mapa = {};
    try {
        // o próprio Odoo soma por produto (uma resposta curta, sem limite de linhas)
        const grupos = await execute("stock.quant", "read_group", [dominio], { fields: ["quantity:sum", "reserved_quantity:sum"], groupby: ["product_id"], lazy: false });
        if (!Array.isArray(grupos)) throw new Error("read_group sem resultado");
        grupos.forEach(g => {
            if (!Array.isArray(g.product_id)) return;
            mapa[g.product_id[0]] = (Number(g.quantity) || 0) - (Number(g.reserved_quantity) || 0);
        });
        return mapa;
    } catch (e) { /* cai na leitura linha a linha abaixo */ }
    let quants;
    try {
        quants = await execute("stock.quant", "search_read", [dominio], { fields: ["product_id", "quantity", "reserved_quantity"] });
    } catch (e) {
        quants = await execute("stock.quant", "search_read", [dominio], { fields: ["product_id", "quantity"] });
    }
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
    if (idsAntes.length) return [];      // já faturado (pedido retomado depois de um reenvio)
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

// Devolve ao estoque de origem os itens de todas as entregas JÁ CONCLUÍDAS de um pedido
// (mesmo processo manual do Odoo: entrega > "Devolução" > criar devolução > "Validar" o recebimento).
// Só devolve o que ainda não foi devolvido, então chamar de novo não duplica a devolução.
async function devolverEntregasDoPedido(orderId) {
    const oid = Number(orderId);
    const devolvidos = [];
    const avisos = [];

    const pickings = await execute("stock.picking", "search_read", [[
        ["sale_id", "=", oid], ["state", "=", "done"], ["picking_type_code", "=", "outgoing"]
    ]], { fields: ["id", "name", "location_id", "location_dest_id", "picking_type_id", "partner_id"] });

    for (const p of (pickings || [])) {
        try {
            // 1) o que saiu nesta entrega
            let moves;
            try {
                moves = await execute("stock.move", "search_read", [[["picking_id", "=", p.id], ["state", "=", "done"]]], { fields: ["id", "quantity"] });
            } catch (e) {
                moves = await execute("stock.move", "search_read", [[["picking_id", "=", p.id], ["state", "=", "done"]]], { fields: ["id", "quantity_done"] });
                moves = moves.map(m => ({ id: m.id, quantity: m.quantity_done }));
            }
            const moveIds = (moves || []).map(m => m.id);
            if (moveIds.length === 0) continue;

            // 2) o que já foi devolvido antes (evita devolver duas vezes)
            const jaDevolvidos = await execute("stock.move", "search_read", [[["origin_returned_move_id", "in", moveIds], ["state", "!=", "cancel"]]], {
                fields: ["origin_returned_move_id", "product_uom_qty", "quantity", "state"]
            }).catch(() => []);
            const devolvidoPorMove = {};
            (jaDevolvidos || []).forEach(r => {
                const origem = Array.isArray(r.origin_returned_move_id) ? r.origin_returned_move_id[0] : r.origin_returned_move_id;
                const qtd = r.state === "done" ? (r.quantity || 0) : (r.product_uom_qty || 0);
                devolvidoPorMove[origem] = (devolvidoPorMove[origem] || 0) + qtd;
            });

            const restante = {};
            let temAlgoParaDevolver = false;
            moves.forEach(m => {
                restante[m.id] = Math.max(0, (m.quantity || 0) - (devolvidoPorMove[m.id] || 0));
                if (restante[m.id] > 0) temAlgoParaDevolver = true;
            });
            if (!temAlgoParaDevolver) continue;

            // 3) cria o recebimento de devolução (o que o botão "Devolução" faz no Odoo).
            // Nesta versão do Odoo o assistente "stock.return.picking" não existe mais:
            // o botão cria direto um recebimento em rascunho, e é isso que fazemos aqui,
            // já com a "Demanda" igual à quantidade que saiu no pedido.
            const origemId = Array.isArray(p.location_id) ? p.location_id[0] : p.location_id;      // estoque de onde saiu
            const clienteLocId = Array.isArray(p.location_dest_id) ? p.location_dest_id[0] : p.location_dest_id;
            const tipoOrigemId = Array.isArray(p.picking_type_id) ? p.picking_type_id[0] : p.picking_type_id;

            // tipo de operação de devolução ("Recebimentos") definido no tipo da entrega
            let tipoDevolucaoId = null;
            let armazemTipoId = null;
            try {
                const defsTipo = await onlyExistingFields("stock.picking.type", { return_picking_type_id: 1, warehouse_id: 1 });
                const camposTipo = Object.keys(defsTipo);
                if (camposTipo.length > 0) {
                    const tp = await execute("stock.picking.type", "read", [[tipoOrigemId]], { fields: camposTipo });
                    if (tp && tp[0] && Array.isArray(tp[0].return_picking_type_id)) tipoDevolucaoId = tp[0].return_picking_type_id[0];
                    if (tp && tp[0] && Array.isArray(tp[0].warehouse_id)) armazemTipoId = tp[0].warehouse_id[0];
                }
            } catch (e) { /* tenta o plano B abaixo */ }
            if (!tipoDevolucaoId) {
                // plano B: tipo "Recebimentos" do mesmo armazém da entrega
                const dom = [["code", "=", "incoming"]];
                if (armazemTipoId) dom.push(["warehouse_id", "=", armazemTipoId]);
                const incoming = await execute("stock.picking.type", "search_read", [dom], { fields: ["id"], limit: 1 }).catch(() => []);
                if (incoming && incoming[0]) tipoDevolucaoId = incoming[0].id;
            }
            if (!tipoDevolucaoId) throw new Error("não foi encontrado o tipo de operação de devolução (Recebimentos) deste local");

            // linhas originais completas (para copiar produto e unidade de medida)
            const movesCompletos = await execute("stock.move", "read", [moveIds]);
            const moveCommands = [];
            for (const mv of movesCompletos) {
                const qtd = restante[mv.id] || 0;
                if (qtd <= 0) continue;
                const uom = Array.isArray(mv.product_uom) ? mv.product_uom[0] : (Array.isArray(mv.uom_id) ? mv.uom_id[0] : null);
                const vals = await onlyExistingFields("stock.move", {
                    product_id: Array.isArray(mv.product_id) ? mv.product_id[0] : mv.product_id,
                    product_uom_qty: qtd,
                    product_uom: uom,
                    uom_id: uom,
                    location_id: clienteLocId,
                    location_dest_id: origemId,
                    origin_returned_move_id: mv.id,
                    picking_type_id: tipoDevolucaoId,
                    origin: "Devolução de " + p.name
                });
                moveCommands.push([0, 0, vals]);
            }

            const pickingVals = await onlyExistingFields("stock.picking", {
                picking_type_id: tipoDevolucaoId,
                partner_id: Array.isArray(p.partner_id) ? p.partner_id[0] : false,
                origin: "Devolução de " + p.name,
                location_id: clienteLocId,
                location_dest_id: origemId,
                return_id: p.id,
                move_ids: moveCommands
            });
            const novoId = await execute("stock.picking", "create", [pickingVals]);
            if (!novoId) throw new Error("o Odoo não criou o recebimento de devolução");

            // 4) validar o recebimento (botão "Validar" do Odoo), com a quantidade devolvida
            let info = await execute("stock.picking", "read", [[novoId]], { fields: ["name", "state"] });
            if (info[0].state === "draft") {
                await execute("stock.picking", "action_confirm", [[novoId]]);
            }
            const novosMoves = await execute("stock.move", "search_read", [[["picking_id", "=", novoId]]], { fields: ["id", "product_uom_qty"] });
            for (const mv of (novosMoves || [])) {
                try {
                    await execute("stock.move", "write", [[mv.id], { quantity: mv.product_uom_qty }]);
                } catch (e2) {
                    await execute("stock.move", "write", [[mv.id], { quantity_done: mv.product_uom_qty }]).catch(() => {});
                }
            }

            const vr = await execute("stock.picking", "button_validate", [[novoId]], { context: { skip_sms: true } });
            // se o Odoo abrir uma janela de confirmação (ex.: criar pendência), responde por ela
            if (vr && typeof vr === "object" && vr.res_model) {
                const wctx = Object.assign({}, vr.context || {}, { skip_sms: true });
                const wid2 = await execute(vr.res_model, "create", [{}], { context: wctx });
                const metodo = vr.res_model === "stock.backorder.confirmation" ? "process_cancel_backorder" : "process";
                await execute(vr.res_model, metodo, [[wid2]], { context: wctx });
            }

            info = await execute("stock.picking", "read", [[novoId]], { fields: ["name", "state"] });
            if (info[0].state === "done") {
                devolvidos.push(info[0].name);
            } else {
                avisos.push("A devolução " + info[0].name + " foi criada, mas não foi validada. Valide-a no Odoo para o item voltar ao estoque.");
            }
        } catch (e) {
            avisos.push("Não foi possível devolver ao estoque a entrega " + p.name + ": " + e.message + " Faça a devolução manualmente no Odoo.");
        }
    }
    return { devolvidos, avisos };
}

// Desfaz o pedido que não deu certo. Devolve true só se ficou TUDO como antes (pedido cancelado e nenhuma entrega feita).
// Se não conseguir, marca o pedido como "FALHA" para o responsável conferir no Odoo.
async function desfazerPedido(orderId) {
    let entregaFeita = false, cancelado = false, devolvido = true;
    try {
        const feitas = await execute("stock.picking", "search_read", [[["sale_id", "=", orderId], ["state", "=", "done"], ["picking_type_code", "=", "outgoing"]]], { fields: ["id"], limit: 1 });
        entregaFeita = !!(feitas && feitas.length);
    } catch (e) { entregaFeita = true; /* sem saber, trata como se tivesse saído */ }
    try {
        await execute("sale.order", "action_cancel", [[orderId]]);
        cancelado = true;
    } catch (e) {
        console.error("não foi possível cancelar o pedido", orderId, semCpf(e.message));
    }
    // a entrega já tinha baixado o estoque: devolve tudo para o local de origem (como o botão "Devolução" do Odoo)
    if (entregaFeita) {
        devolvido = false;
        try {
            const r = await devolverEntregasDoPedido(orderId);
            devolvido = r.avisos.length === 0;
            if (!devolvido) console.error("devolução do pedido", orderId, semCpf(r.avisos.join(" | ")));
        } catch (e) {
            console.error("devolução do pedido", orderId, semCpf(e.message));
        }
    }
    const limpo = cancelado && devolvido;
    if (!limpo) {
        console.error("ATENÇÃO: pedido", orderId, "ficou incompleto no Odoo (cancelado:", cancelado, "estoque devolvido:", devolvido, ")");
        try { await execute("sale.order", "write", [[orderId], { client_order_ref: "AUTOATENDIMENTO - FALHA (conferir estoque e entrega)" }]); } catch (e) { /* melhor esforço */ }
    }
    return limpo;
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

// Procura no Odoo um pedido já criado com esta chave (vale entre servidores diferentes e depois de timeouts)
async function pedidoDaChave(requestId) {
    const r = await execute("sale.order", "search_read", [[["origin", "=", "AUTO:" + requestId], ["state", "!=", "cancel"]]], { fields: ["id", "state"], limit: 1 });
    return (r && r[0]) || null;
}

async function resultadoDoPedido(orderId, forma, vencimento) {
    try {
        const ped = await execute("sale.order", "read", [[orderId]], { fields: ["name", "amount_total"] });
        if (ped && ped[0]) return { ok: true, numero: ped[0].name || String(orderId), total: ped[0].amount_total || 0, forma, vencimento };
    } catch (e) { console.error("ler pedido", orderId, semCpf(e.message)); }
    // o pedido JÁ existe: não devolve erro ao cliente por causa de uma leitura que falhou
    return { ok: true, numero: String(orderId), total: null, forma, vencimento };
}

// Tudo o que vem depois de o pedido estar confirmado e a entrega feita (não desfaz o pedido se falhar)
async function finalizarPedido(orderId, vencimento) {
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
}

async function criarPedido({ wh, parceiro, itens, forma, vencimento, requestId }) {
    // reenvio do mesmo pedido (internet caiu, outro servidor atendeu, tempo esgotou): retoma em vez de criar de novo
    let orderId = null;
    const existente = await pedidoDaChave(requestId);
    if (existente && existente.state !== "draft") {
        const pend = await execute("stock.picking", "search_read", [[["sale_id", "=", existente.id], ["state", "not in", ["done", "cancel"]]]], { fields: ["id"], limit: 1 });
        if (pend && pend.length) await baixarEstoqueDoPedido(existente.id);
        await finalizarPedido(existente.id, vencimento);
        return resultadoDoPedido(existente.id, forma, vencimento);
    }
    if (existente) orderId = existente.id;      // rascunho que ficou pelo caminho: segue daqui

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
        origin: "AUTO:" + requestId,      // chave do pedido: permite reconhecer um reenvio mesmo em outro servidor
        order_line: itens.map(it => [0, 0, {
            product_id: it.id,
            product_uom_qty: it.qtd,
            price_unit: Number(porId.get(it.id).list_price) || 0,
            discount: 0
        }])
    };
    const vals = await onlyExistingFields("sale.order", base);
    if (!orderId) orderId = await execute("sale.order", "create", [vals]);

    try {
        await execute("sale.order", "action_confirm", [[orderId]]);
        await baixarEstoqueDoPedido(orderId);
    } catch (e) {
        console.error("Falha ao confirmar/baixar estoque do pedido", orderId, semCpf(e.message));
        const limpo = await desfazerPedido(orderId);
        throw new ErroPublico(limpo
            ? "Não foi possível concluir o pedido agora. Nada foi cobrado. Tente novamente ou fale com o responsável."
            : "Não foi possível concluir o pedido e ele pode ter ficado incompleto. Fale com o responsável antes de tentar de novo.", 502);
    }

    // o que vem depois não desfaz o pedido: no pior caso o responsável gera a fatura pelo painel
    await finalizarPedido(orderId, vencimento);
    return resultadoDoPedido(orderId, forma, vencimento);
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
        barrar("geral", 1500);       // muitos clientes podem usar o mesmo Wi-Fi/IP do local
        const wh = await armazemPorToken(body.token);

        if (acao === "local") {
            return res.status(200).json({ ok: true, local: wh.name, pix_chave: (await pixChave()) || null, max_dias_vencimento: MAX_DIAS_VENCIMENTO });
        }

        if (acao === "produtos") {
            return res.status(200).json({ ok: true, produtos: await listarProdutos(wh) });
        }

        if (acao === "cpf_buscar") {
            barrar("cpf", 60);
            if (!limitar("cpf-busca:" + limparCpf(body.cpf), 12, JANELA)) throw new ErroPublico("Muitas tentativas com este CPF. Aguarde alguns minutos.", 429);
            const cpf = limparCpf(body.cpf);
            if (!cpfValido(cpf)) throw new ErroPublico("CPF inválido. Confira os 11 números.");
            const p = await parceiroPorCpf(cpf);
            if (!p) return res.status(200).json({ ok: true, existe: false });
            return res.status(200).json({ ok: true, existe: true, nome_mascarado: mascararNome(p.name), pode_pagar_depois: await podePagarDepois(p) });
        }

        if (acao === "cliente_criar") {
            barrar("cadastro", 20);
            if (!limitar("cadastro-cpf:" + limparCpf(body.cpf), 5, JANELA)) throw new ErroPublico("Muitas tentativas com este CPF. Aguarde alguns minutos.", 429);
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
            barrar("pedido", 40);
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
                const r = await criarPedido({ wh, parceiro, itens, forma, vencimento, requestId });
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
