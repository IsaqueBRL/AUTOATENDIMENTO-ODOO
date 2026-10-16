// =====================================================================
// SITE DO CLIENTE — Autoatendimento
// QR Code (?l=CODIGO) -> CPF -> produtos -> pagamento. Tudo passa pela API /api/auto.
// =====================================================================
(() => {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const CHAVE_TOKEN = 'ad_token';
    const CHAVE_CPF = 'ad_cpf';

    // ---------- utilidades ----------
    const brl = (v) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
    const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const guardar = {
        ler(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
        gravar(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sem armazenamento: segue sem lembrar */ } },
        apagar(k) { try { localStorage.removeItem(k); } catch (e) { /* ok */ } }
    };
    function criar(tag, classe, texto) {
        const el = document.createElement(tag);
        if (classe) el.className = classe;
        if (texto !== undefined) el.textContent = texto;
        return el;
    }
    function dataISO(d) { return d.toLocaleDateString('sv-SE'); }
    function dataBR(iso) { const [a, m, d] = iso.split('-'); return d + '/' + m + '/' + a; }
    function cpfValido(c) {
        if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
        const dig = (base) => {
            let s = 0;
            for (let i = 0; i < base.length; i++) s += Number(base[i]) * (base.length + 1 - i);
            const r = (s * 10) % 11;
            return r === 10 ? 0 : r;
        };
        return dig(c.slice(0, 9)) === Number(c[9]) && dig(c.slice(0, 10)) === Number(c[10]);
    }

    let toastTimer = null;
    function aviso(msg, tipo) {
        const el = $('toast');
        el.textContent = msg;
        el.className = 'show ' + (tipo || '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = ''; }, 4200);
    }

    // ---------- estado ----------
    const estado = {
        token: null,
        local: '',
        pixChave: null,
        maxDias: 30,
        produtos: [],
        carrinho: new Map(),     // id -> quantidade
        cpf: '',
        nomeMascarado: '',
        podeDepois: false,
        identificado: false,     // CPF já confirmado logo na abertura (não pergunta de novo ao pagar)
        cpfInicial: false,       // a tela de CPF está aberta na abertura do site, não no pagamento
        requestId: null,
        enviando: false
    };
    const produtoPorId = (id) => estado.produtos.find(p => p.id === id);

    // ---------- API ----------
    async function api(acao, dados) {
        let resp;
        try {
            resp = await fetch('/api/auto', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({ action: acao, token: estado.token }, dados || {}))
            });
        } catch (e) {
            return { rede: true, status: 0, dados: { ok: false, error: 'Sem conexão com a internet. Tente de novo.' } };
        }
        let corpo = {};
        try { corpo = await resp.json(); } catch (e) { corpo = { ok: false, error: 'Resposta inesperada do servidor.' }; }
        return { rede: false, status: resp.status, dados: corpo };
    }

    // ---------- telas (sheets) ----------
    function abrir(id) {
        document.querySelectorAll('.sheet-overlay.show').forEach(el => el.classList.remove('show'));
        $(id).classList.add('show');
    }
    function fecharTudo() {
        document.querySelectorAll('.sheet-overlay.show').forEach(el => el.classList.remove('show'));
    }
    document.addEventListener('click', (e) => {
        const alvo = e.target.closest('[data-fechar], [data-voltar]');
        if (!alvo) return;
        if (alvo.hasAttribute('data-voltar')) abrir(alvo.getAttribute('data-voltar'));
        else fecharTudo();
    });

    function erroCampo(id, msg) {
        const el = $(id);
        el.textContent = msg || '';
        el.classList.toggle('show', !!msg);
    }

    // ---------- produtos ----------
    const CORES = ['#9b59b6', '#2ecc71', '#e67e22', '#3498db', '#e74c3c', '#16a085', '#d35400', '#8e44ad'];
    function corDoProduto(nome) {
        let h = 0;
        for (let i = 0; i < nome.length; i++) h = nome.charCodeAt(i) + ((h << 5) - h);
        return CORES[Math.abs(h) % CORES.length];
    }

    function totalCarrinho() {
        let t = 0;
        estado.carrinho.forEach((q, id) => { const p = produtoPorId(id); if (p) t += p.preco * q; });
        return Math.round(t * 100) / 100;
    }
    function qtdCarrinho() {
        let n = 0;
        estado.carrinho.forEach(q => { n += q; });
        return n;
    }

    function mudarQtd(id, delta) {
        const p = produtoPorId(id);
        if (!p) return;
        const novo = (estado.carrinho.get(id) || 0) + delta;
        if (novo > p.estoque) { aviso('Só há ' + p.estoque + ' disponível(is) de ' + p.nome + '.', 'warning'); return; }
        if (novo <= 0) estado.carrinho.delete(id); else estado.carrinho.set(id, novo);
        renderProdutos();
        renderCarrinho();
    }

    function stepper(classe, id, qtd) {
        const box = criar('div', classe);
        const menos = criar('button', '', '−'); menos.type = 'button'; menos.setAttribute('aria-label', 'Diminuir');
        const val = criar('span', classe === 'qtd-stepper' ? 'qtd-val' : 'val', String(qtd));
        const mais = criar('button', '', '+'); mais.type = 'button'; mais.setAttribute('aria-label', 'Aumentar');
        menos.addEventListener('click', () => mudarQtd(id, -1));
        mais.addEventListener('click', () => mudarQtd(id, 1));
        box.append(menos, val, mais);
        return box;
    }

    function renderProdutos() {
        const termo = semAcento($('busca-produto').value).trim();
        const grid = $('produtos-grid');
        grid.replaceChildren();
        const lista = estado.produtos.filter(p => !termo || semAcento(p.nome).includes(termo));
        $('produtos-empty').hidden = lista.length > 0;

        lista.forEach(p => {
            const noCarrinho = estado.carrinho.get(p.id) || 0;
            const card = criar('div', 'produto-card');
            const thumb = criar('div', 'produto-thumb', (p.nome.charAt(0) || '?').toUpperCase());
            thumb.style.background = corDoProduto(p.nome);
            const estq = criar('div', 'produto-estoque' + (p.estoque <= 5 ? ' baixo' : ''), p.estoque + ' disponível(is)');
            const area = criar('div', 'qtd-area');
            if (noCarrinho > 0) {
                area.append(stepper('qtd-stepper', p.id, noCarrinho));
            } else {
                const b = criar('button', 'btn-add-produto', '➕ Adicionar');
                b.type = 'button';
                b.addEventListener('click', () => mudarQtd(p.id, 1));
                area.append(b);
            }
            card.append(thumb, criar('div', 'produto-nome', p.nome), criar('div', 'produto-preco', brl(p.preco)), estq, area);
            grid.append(card);
        });
    }

    function renderCarrinho() {
        const qtd = qtdCarrinho();
        const total = totalCarrinho();
        $('cart-bar-count').textContent = String(qtd);
        $('cart-bar-total').textContent = brl(total);
        $('cart-bar').classList.toggle('show', qtd > 0);
        $('cart-total-footer').textContent = brl(total);

        const lista = $('cart-lista');
        lista.replaceChildren();
        const ids = [...estado.carrinho.keys()].filter(id => produtoPorId(id));
        $('cart-empty').hidden = ids.length > 0;
        ids.forEach(id => {
            const p = produtoPorId(id);
            const q = estado.carrinho.get(id);
            const linha = criar('div', 'cart-item');
            const info = criar('div', 'cart-item-info');
            info.append(criar('div', 'cart-item-nome', p.nome), criar('div', 'cart-item-preco', brl(p.preco) + ' / un.'));
            const rem = criar('button', 'cart-item-remove', '✕');
            rem.type = 'button'; rem.setAttribute('aria-label', 'Remover');
            rem.addEventListener('click', () => { estado.carrinho.delete(id); renderProdutos(); renderCarrinho(); });
            linha.append(info, stepper('cart-item-stepper', id, q), criar('div', 'cart-item-subtotal', brl(p.preco * q)), rem);
            lista.append(linha);
        });
    }

    // Atualiza a lista de produtos e ajusta o carrinho ao estoque atual
    async function carregarProdutos(silencioso) {
        const r = await api('produtos');
        if (!r.dados.ok) {
            if (!silencioso) aviso(r.dados.error || 'Não foi possível carregar os produtos.', 'danger');
            return false;
        }
        estado.produtos = r.dados.produtos || [];
        let mudou = false;
        [...estado.carrinho.keys()].forEach(id => {
            const p = produtoPorId(id);
            if (!p) { estado.carrinho.delete(id); mudou = true; return; }
            if (estado.carrinho.get(id) > p.estoque) { estado.carrinho.set(id, p.estoque); mudou = true; }
        });
        if (mudou) aviso('O estoque mudou e seu carrinho foi ajustado.', 'warning');
        renderProdutos();
        renderCarrinho();
        return true;
    }

    // ---------- fluxo: CPF ----------
    $('input-cpf').addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '').slice(0, 11); // sempre só números
        erroCampo('erro-cpf', '');
    });
    $('input-cpf').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); confirmarCpf(); } });

    $('cart-bar').addEventListener('click', () => { renderCarrinho(); abrir('sheet-carrinho'); });

    $('btn-ir-checkout').addEventListener('click', () => {
        if (qtdCarrinho() === 0) { aviso('Seu carrinho está vazio.', 'warning'); return; }
        if (estado.identificado && estado.cpf) { abrirPagamento(); return; }   // já se identificou ao abrir o site
        estado.cpfInicial = false;
        $('sheet-cpf').classList.remove('inicio');
        $('cpf-total-resumo').textContent = brl(totalCarrinho());
        const lembrado = guardar.ler(CHAVE_CPF) || '';
        $('input-cpf').value = /^\d{11}$/.test(lembrado) ? lembrado : '';
        $('input-lembrar').checked = !!lembrado;
        erroCampo('erro-cpf', '');
        abrir('sheet-cpf');
        setTimeout(() => $('input-cpf').focus(), 150);
    });

    let verificando = false;
    async function confirmarCpf() {
        if (verificando) return;
        const cpf = $('input-cpf').value.replace(/\D/g, '');
        if (!cpfValido(cpf)) { erroCampo('erro-cpf', 'CPF inválido. Confira os 11 números.'); return; }
        verificando = true;
        const btn = $('btn-confirmar-cpf');
        btn.disabled = true; btn.textContent = 'Verificando...';
        try {
            const r = await api('cpf_buscar', { cpf });
            if (!r.dados.ok) { erroCampo('erro-cpf', r.dados.error || 'Não foi possível verificar agora.'); return; }
            estado.cpf = cpf;
            if (r.dados.existe) {
                estado.nomeMascarado = r.dados.nome_mascarado;
                estado.podeDepois = !!r.dados.pode_pagar_depois;
                $('nome-confirma').textContent = estado.nomeMascarado;
                abrir('sheet-confirma');
            } else {
                $('input-nome-novo').value = '';
                erroCampo('erro-nome', '');
                abrir('sheet-novo');
                setTimeout(() => $('input-nome-novo').focus(), 150);
            }
        } finally {
            verificando = false;
            btn.disabled = false; btn.textContent = 'Continuar';
        }
    }
    $('btn-confirmar-cpf').addEventListener('click', confirmarCpf);

    $('btn-nao-sou-eu').addEventListener('click', () => { abrir('sheet-cpf'); $('input-cpf').focus(); });

    function lembrarCpfSeQuiser() {
        if ($('input-lembrar').checked) guardar.gravar(CHAVE_CPF, estado.cpf); else guardar.apagar(CHAVE_CPF);
    }

    // Depois de identificar o cliente: na abertura do site, só volta para os produtos; no pagamento, segue para pagar.
    function seguirDepoisDeIdentificar() {
        if (estado.cpfInicial) {
            estado.cpfInicial = false;
            estado.identificado = true;
            $('sheet-cpf').classList.remove('inicio');
            fecharTudo();
            aviso('Olá, ' + estado.nomeMascarado + '! Escolha seus produtos.', 'success');
        } else {
            abrirPagamento();
        }
    }

    $('btn-sim-sou-eu').addEventListener('click', () => { lembrarCpfSeQuiser(); seguirDepoisDeIdentificar(); });

    let cadastrando = false;
    $('btn-cadastrar').addEventListener('click', async () => {
        if (cadastrando) return;
        const nome = $('input-nome-novo').value.replace(/\s+/g, ' ').trim();
        if (nome.length < 3 || !/^[\p{L}][\p{L} .'’-]*$/u.test(nome)) { erroCampo('erro-nome', 'Digite seu nome (apenas letras).'); return; }
        cadastrando = true;
        const btn = $('btn-cadastrar');
        btn.disabled = true; btn.textContent = 'Cadastrando...';
        try {
            const r = await api('cliente_criar', { cpf: estado.cpf, nome });
            if (!r.dados.ok) { erroCampo('erro-nome', r.dados.error || 'Não foi possível cadastrar agora.'); return; }
            estado.nomeMascarado = r.dados.nome_mascarado;
            estado.podeDepois = !!r.dados.pode_pagar_depois;
            lembrarCpfSeQuiser();
            if (!estado.cpfInicial) aviso('Cadastro feito!', 'success');
            seguirDepoisDeIdentificar();
        } finally {
            cadastrando = false;
            btn.disabled = false; btn.textContent = 'Cadastrar e continuar';
        }
    });
    $('input-nome-novo').addEventListener('input', () => erroCampo('erro-nome', ''));

    // ---------- fluxo: pagamento ----------
    function novaTentativa() {
        estado.requestId = (crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)));
    }

    function abrirPagamento() {
        novaTentativa();
        const total = brl(totalCarrinho());
        ['pagamento-total', 'pix-total', 'especie-total', 'depois-total'].forEach(id => { $(id).textContent = total; });
        $('opcao-pix').hidden = !estado.pixChave;
        $('opcao-depois').hidden = !estado.podeDepois;
        abrir('sheet-pagamento');
    }

    $('opcao-pix').addEventListener('click', () => {
        $('pix-chave-exibida').value = estado.pixChave || '';
        abrir('sheet-pix');
    });
    $('opcao-especie').addEventListener('click', () => abrir('sheet-especie'));
    $('opcao-depois').addEventListener('click', () => {
        const hoje = new Date();
        const max = new Date(hoje.getTime() + estado.maxDias * 86400000);
        const padrao = new Date(hoje.getTime() + Math.min(7, estado.maxDias) * 86400000);
        const campo = $('input-vencimento');
        campo.min = dataISO(hoje);
        campo.max = dataISO(max);
        campo.value = dataISO(padrao);
        $('depois-ajuda').textContent = 'Você pode escolher uma data de hoje até ' + dataBR(dataISO(max)) + '.';
        erroCampo('erro-data', '');
        abrir('sheet-depois');
    });

    $('btn-copiar-pix').addEventListener('click', async () => {
        const campo = $('pix-chave-exibida');
        try {
            await navigator.clipboard.writeText(campo.value);
            aviso('Chave Pix copiada!', 'success');
        } catch (e) {
            campo.focus(); campo.select();
            aviso('Toque e segure na chave para copiar.', 'warning');
        }
    });

    async function enviarPedido(forma, vencimento, botao, textoBotao) {
        if (estado.enviando) return;
        estado.enviando = true;
        document.querySelectorAll('.btn-primario').forEach(b => { b.disabled = true; });
        botao.textContent = '💾 Enviando...';
        try {
            const itens = [...estado.carrinho.entries()].map(([id, qtd]) => ({ id, qtd }));
            const r = await api('pedido_criar', { cpf: estado.cpf, request_id: estado.requestId, forma, vencimento, itens });
            if (r.dados.ok) {
                mostrarSucesso(r.dados);
                estado.carrinho.clear();
                estado.requestId = null;
                carregarProdutos(true);
                return;
            }
            if (!r.rede) novaTentativa(); // erro definitivo: a próxima tentativa é um pedido novo
            aviso(r.dados.error || 'Não foi possível registrar o pedido.', 'danger');
            if (r.status === 409) { await carregarProdutos(true); abrir('sheet-carrinho'); }
        } finally {
            estado.enviando = false;
            document.querySelectorAll('.btn-primario').forEach(b => { b.disabled = false; });
            botao.textContent = textoBotao;
        }
    }

    $('btn-finalizar-pix').addEventListener('click', () => enviarPedido('pix', null, $('btn-finalizar-pix'), '✅ Já paguei, finalizar'));
    $('btn-finalizar-especie').addEventListener('click', () => enviarPedido('especie', null, $('btn-finalizar-especie'), '✅ Confirmar pedido'));
    $('btn-finalizar-depois').addEventListener('click', () => {
        const v = $('input-vencimento').value;
        if (!v || v < $('input-vencimento').min || v > $('input-vencimento').max) { erroCampo('erro-data', 'Escolha uma data dentro do prazo.'); return; }
        enviarPedido('depois', v, $('btn-finalizar-depois'), '✅ Confirmar pedido');
    });

    function mostrarSucesso(d) {
        $('sucesso-titulo').textContent = 'Pedido registrado! ✅';
        let msg = 'Pedido ' + d.numero + ' no valor de ' + brl(d.total) + '. ';
        if (d.forma === 'pix') msg += 'Seu Pix será conferido pelo responsável.';
        else if (d.forma === 'especie') msg += 'Deixe o pagamento em dinheiro conforme combinado. Ele será conferido pelo responsável.';
        else msg += 'Pagamento combinado até ' + dataBR(d.vencimento) + '.';
        $('sucesso-msg').textContent = msg + ' Obrigado!';
        abrir('sheet-sucesso');
    }
    $('btn-novo-pedido').addEventListener('click', () => { estado.identificado = false; fecharTudo(); });

    $('busca-produto').addEventListener('input', renderProdutos);

    // ---------- convite para instalar o app ----------
    // Android/computador: usa o botão nativo de instalação do navegador (evento beforeinstallprompt).
    // iPhone/iPad: o navegador não permite instalar por código, então mostramos o passo a passo.
    const CHAVE_INSTALAR_ATE = 'ad_instalar_ate';
    const DIAS_SEM_INSISTIR = 3;      // depois de "Cancelar", só volta a perguntar depois desses dias
    let instalarEvento = null;        // evento guardado do navegador (só existe quando dá para instalar)
    let instalarLiberado = false;     // só convida depois que o site terminou de carregar
    let cpfInicialPendente = false;   // depois do convite (1º aviso), pede o CPF (2º aviso) uma única vez

    function jaEstaInstalado() {
        return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    }
    function ehIOS() {
        // iPadOS moderno se identifica como "Mac", então também olhamos se tem tela de toque
        return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }
    function ehSafari() {
        return !/crios|fxios|edgios|opios|gsa\//i.test(navigator.userAgent);
    }
    function conviteSilenciado() { return Number(guardar.ler(CHAVE_INSTALAR_ATE)) > Date.now(); }
    function silenciarConvite(dias) { guardar.gravar(CHAVE_INSTALAR_ATE, String(Date.now() + dias * 86400000)); }

    // Devolve true se mostrou o convite.
    function mostrarConviteInstalar() {
        if (!instalarLiberado || jaEstaInstalado() || conviteSilenciado()) return false;
        if (document.querySelector('.sheet-overlay.show')) return false; // não interrompe quem está montando o pedido
        const ios = ehIOS();
        if (!ios && !instalarEvento) return false; // navegador sem suporte a instalação: não há o que oferecer
        $('instalar-android').hidden = ios;
        $('instalar-ios').hidden = !ios;
        $('instalar-ios-safari').hidden = !ios || ehSafari();
        abrir('sheet-instalar');
        return true;
    }
    // Android/computador: o navegador às vezes libera a instalação alguns instantes depois de abrir. Espera um pouco
    // para o convite poder ser o primeiro aviso.
    function esperarLiberarInstalacao(ms) {
        return new Promise((ok) => {
            if (jaEstaInstalado() || conviteSilenciado() || ehIOS() || instalarEvento) { ok(); return; }
            const limite = Date.now() + ms;
            const t = setInterval(() => { if (instalarEvento || Date.now() >= limite) { clearInterval(t); ok(); } }, 100);
        });
    }
    // 2º aviso: pede o CPF para quem ainda não tem CPF guardado neste aparelho. Quem fechar a tela segue para os produtos
    // e o CPF é pedido na hora de pagar, como antes.
    function abrirCpfInicial() {
        if (!cpfInicialPendente) return;
        cpfInicialPendente = false;
        if (estado.identificado || document.querySelector('.sheet-overlay.show')) return;
        if (/^\d{11}$/.test(guardar.ler(CHAVE_CPF) || '')) return; // já usou este aparelho: confirma o CPF na hora de pagar
        estado.cpfInicial = true;
        $('sheet-cpf').classList.add('inicio');
        $('input-cpf').value = '';
        $('input-lembrar').checked = false;
        erroCampo('erro-cpf', '');
        abrir('sheet-cpf');
        setTimeout(() => $('input-cpf').focus(), 150);
    }
    function dispensarConvite() {
        $('sheet-instalar').classList.remove('show');
        silenciarConvite(DIAS_SEM_INSISTIR);
        abrirCpfInicial();
    }

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();            // guarda o evento para abrir a instalação só quando a pessoa tocar em "Baixar app"
        instalarEvento = e;
        mostrarConviteInstalar();      // se o site já carregou, convida agora; senão convida quando terminar de carregar
    });
    window.addEventListener('appinstalled', () => {
        instalarEvento = null;
        silenciarConvite(3650);        // já instalou: não pergunta mais
        $('sheet-instalar').classList.remove('show');
        aviso('App instalado! Procure o ícone na sua tela.', 'success');
        abrirCpfInicial();
    });

    $('btn-instalar-baixar').addEventListener('click', async () => {
        const ev = instalarEvento;
        if (!ev) { dispensarConvite(); return; }
        instalarEvento = null;         // cada evento só pode ser usado uma vez
        $('sheet-instalar').classList.remove('show');
        try {
            ev.prompt();               // precisa ser chamado direto no toque da pessoa
            const escolha = await ev.userChoice;
            if (escolha.outcome !== 'accepted') silenciarConvite(DIAS_SEM_INSISTIR);
        } catch (e) {
            silenciarConvite(DIAS_SEM_INSISTIR);
        }
        abrirCpfInicial();
    });
    $('btn-instalar-cancelar').addEventListener('click', dispensarConvite);
    $('btn-instalar-entendi').addEventListener('click', dispensarConvite);
    $('btn-instalar-x').addEventListener('click', dispensarConvite);
    $('sheet-instalar').addEventListener('click', (e) => { if (e.target === e.currentTarget) dispensarConvite(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && $('sheet-instalar').classList.contains('show')) dispensarConvite();
    });

    // ---------- início ----------
    function telaAviso(icone, titulo, msg) {
        $('loading-overlay').classList.add('hide');
        $('header').hidden = true;
        $('app').hidden = true;
        $('aviso-icone').textContent = icone;
        $('aviso-titulo').textContent = titulo;
        $('aviso-msg').textContent = msg;
        $('tela-aviso').hidden = false;
    }

    function lerToken() {
        let t = null;
        try { t = new URLSearchParams(location.search).get('l'); } catch (e) { /* ok */ }
        if (t && /^[A-Za-z0-9_-]{16}$/.test(t)) { guardar.gravar(CHAVE_TOKEN, t); return t; }
        const g = guardar.ler(CHAVE_TOKEN);
        return g && /^[A-Za-z0-9_-]{16}$/.test(g) ? g : null;
    }

    async function iniciar() {
        estado.token = lerToken();
        if (!estado.token) {
            telaAviso('📷', 'Escaneie o QR Code do local', 'Aponte a câmera do celular para o QR Code colado no local onde você está para ver os produtos disponíveis.');
            return;
        }
        // o app instalado a partir deste QR abre direto neste local
        $('link-manifest').setAttribute('href', '/api/manifest?l=' + encodeURIComponent(estado.token));

        const r = await api('local');
        if (!r.dados.ok) {
            if (r.status === 404) {
                guardar.apagar(CHAVE_TOKEN);
                telaAviso('⚠️', 'QR Code inválido', 'Este QR Code não está mais ativo. Escaneie o QR Code do local novamente.');
            } else {
                telaAviso('📡', 'Não foi possível carregar', r.dados.error || 'Tente novamente em instantes.');
            }
            return;
        }
        estado.local = r.dados.local;
        estado.pixChave = r.dados.pix_chave || null;
        estado.maxDias = r.dados.max_dias_vencimento || 30;
        $('local-badge-txt').textContent = '📍 Retirada em: ' + estado.local;
        $('header').hidden = false;
        $('app').hidden = false;
        await carregarProdutos(false);
        await esperarLiberarInstalacao(2000);
        $('loading-overlay').classList.add('hide');

        // site pronto (com um QR válido). 1º aviso: convite para instalar o app. 2º aviso: CPF.
        instalarLiberado = true;
        cpfInicialPendente = true;
        if (!mostrarConviteInstalar()) abrirCpfInicial();

        // mantém estoque em dia enquanto a tela está aberta
        setInterval(() => { if (!document.hidden && !estado.enviando) carregarProdutos(true); }, 45000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden && !estado.enviando) carregarProdutos(true); });
    }

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => { navigator.serviceWorker.register('/service-worker.js').catch(() => {}); });
    }
    iniciar();
})();
