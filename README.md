# Deuris Candy — Autoatendimento

Site instalável (PWA) em que o cliente escaneia o QR Code do local, informa o CPF, escolhe os produtos e paga (Pix, dinheiro ou "pagar depois" para clientes liberados). Integrado ao Odoo.

## Variáveis de ambiente (Vercel → Settings → Environment Variables)

| Nome | Obrigatória | Descrição |
|---|---|---|
| `ODOO_URL` | sim | Ex.: `https://deuris-candy-2.odoo.com` |
| `ODOO_DB` | sim | Nome do banco do Odoo |
| `ODOO_USER` | sim | Login do usuário da integração |
| `ODOO_API_KEY` | sim | Chave de API desse usuário |
| `QR_SECRET` | sim | Senha longa (16+ caracteres). **A mesma** deve ser colocada no projeto do painel (PC) |
| `PIX_CHAVE` | não | Reserva da chave Pix. O normal é definir a chave na tela QR CODES do painel |
| `TAG_PAGAR_DEPOIS` | não | Etiqueta do contato liberado para pagar depois (padrão: `Autoatendimento: pagar depois`) |
| `MAX_DIAS_VENCIMENTO` | não | Prazo máximo do "pagar depois" (padrão: 30) |
| `FORCED_INVOICE_ACCOUNT_CODE` | não | Conta contábil forçada na fatura (padrão: `3.01.01.01.01.04`) |
| `FUSO_HORARIO` | não | Padrão: `America/Manaus` |

Depois de alterar variáveis, faça um novo deploy.

## Configuração no Odoo

1. Em Contatos → Configuração → Etiquetas, crie `Autoatendimento: pagar depois`.
2. Coloque essa etiqueta somente nos clientes de confiança que podem pagar depois.
3. Antes de divulgar ao público, troque a chave de administrador por um usuário com permissões limitadas (vendas, estoque, contatos, faturamento).

## QR Codes

No painel (PC), abra **QR CODES**, informe o endereço deste site, e imprima/baixe um QR por local. Cada QR carrega um código calculado com `QR_SECRET`; mudar a `QR_SECRET` invalida todos os QR já impressos.

## Observações

- O limite de tentativas fica na memória de cada instância (segura abusos simples, não é global).
- CPF é gravado só com dígitos; nada de CPF em logs.
- Nenhum pedido é marcado como pago sem confirmação do dono.
