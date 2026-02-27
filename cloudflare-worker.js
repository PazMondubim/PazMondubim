/**
 * Cloudflare Worker - Proxy Permanente para Paz Church Mondubim
 * 
 * URL PERMANENTE GRATUITA: https://bot-mondubim.SEU-USUARIO.workers.dev
 * 
 * Como configurar:
 * 1. Acesse https://workers.cloudflare.com (crie conta grátis se não tiver)
 * 2. Clique em "Create Application" > "Create Worker"
 * 3. Apague o código padrão e cole todo esse arquivo
 * 4. Clique em "Save and Deploy"
 * 5. Vá em "Settings" > "Variables" > adicione:
 *    - Variable name: BACKEND_URL
 *    - Value: https://projetomondubim-XXXXX.b4a.run  (sua URL atual do Back4App)
 * 6. Quando o Back4App mudar a URL, só atualizar BACKEND_URL aqui!
 */

export default {
    async fetch(request, env) {
        const backendUrl = env.BACKEND_URL;

        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders()
            });
        }

        if (!backendUrl) {
            return new Response(
                JSON.stringify({ error: 'BACKEND_URL não configurado nas variáveis do Worker.' }),
                { status: 500, headers: { 'Content-Type': 'application/json' } }
            );
        }

        try {
            const url = new URL(request.url);
            const targetUrl = backendUrl.replace(/\/$/, '') + url.pathname + url.search;

            // Clonar headers mas remover os que causam problema no proxy
            const headers = new Headers();
            for (const [key, value] of request.headers.entries()) {
                const lower = key.toLowerCase();
                // Não repassar headers de host para evitar conflito
                if (lower !== 'host' && lower !== 'cf-connecting-ip' && lower !== 'cf-ray') {
                    headers.set(key, value);
                }
            }

            const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

            const proxyRequest = new Request(targetUrl, {
                method: request.method,
                headers,
                body: hasBody ? request.body : null,
                // Necessário para não causar erro com body ReadableStream
                duplex: hasBody ? 'half' : undefined,
            });

            const response = await fetch(proxyRequest);

            // Copiar a resposta adicionando headers de CORS
            const newHeaders = new Headers(response.headers);
            const cors = corsHeaders();
            for (const [key, value] of Object.entries(cors)) {
                newHeaders.set(key, value);
            }

            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: newHeaders,
            });

        } catch (err) {
            return new Response(
                JSON.stringify({
                    error: 'Falha ao conectar com o servidor.',
                    detail: err.message,
                    backend: backendUrl
                }),
                { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
            );
        }
    }
};

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
    };
}
