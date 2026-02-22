/**
 * Serviço de Text-to-Speech (TTS) GRATUITO
 * Usa a API não-oficial do Google Translate TTS.
 * - Sem pacotes extra (usa módulo nativo https do Node.js)
 * - Funciona em servidores cloud (Koyeb, Render, Railway, etc.)
 * - Voz em Português do Brasil (pt-BR)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

// Pasta temporária para áudios gerados
const TEMP_DIR = path.join(__dirname, '../../temp_tts');

// Garante que a pasta temporária existe
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Limpa emojis e formatação WhatsApp do texto antes de sintetizar.
 */
function limparTextoParaTTS(texto: string): string {
    return texto
        // Remove emojis (range amplo unicode)
        .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}]/gu, '')
        // Remove asteriscos de bold WhatsApp
        .replace(/\*/g, '')
        // Remove underline de itálico
        .replace(/_/g, ' ')
        // Quebras de linha viram pausas
        .replace(/\n+/g, '. ')
        .trim();
}

/**
 * Faz download de uma URL HTTPS para um arquivo local.
 */
function downloadToFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);

        const req = https.get(url, {
            headers: {
                // User-Agent necessário — Google bloqueia sem ele
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
                'Referer': 'https://translate.google.com/',
                'Accept': '*/*',
            },
            timeout: 10000, // 10 segundos de timeout
        }, (res) => {
            // Seguir redirecionamentos (Google às vezes redireciona)
            if (res.statusCode === 301 || res.statusCode === 302) {
                const location = res.headers.location;
                if (location) {
                    file.close();
                    downloadToFile(location, destPath).then(resolve).catch(reject);
                    return;
                }
            }

            if (res.statusCode !== 200) {
                file.close();
                fs.unlink(destPath, () => { });
                reject(new Error(`HTTP ${res.statusCode} do Google TTS`));
                return;
            }

            res.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        });

        req.on('error', (err) => {
            file.close();
            fs.unlink(destPath, () => { });
            reject(err);
        });

        req.on('timeout', () => {
            req.destroy();
            file.close();
            fs.unlink(destPath, () => { });
            reject(new Error('Timeout ao conectar ao Google TTS'));
        });
    });
}

/**
 * Converte texto em arquivo de áudio MP3 usando Google Translate TTS (gratuito).
 * Retorna o caminho do arquivo gerado, ou null em caso de erro.
 *
 * Limite: ~200 caracteres por requisição. Textos maiores são truncados.
 */
export async function textToSpeech(texto: string): Promise<string | null> {
    const textoLimpo = limparTextoParaTTS(texto);

    if (!textoLimpo || textoLimpo.length < 3) {
        return null;
    }

    // Google TTS aceita ~200 chars por request. Trunca se necessário.
    const textoFinal = textoLimpo.length > 200
        ? textoLimpo.substring(0, 197) + '...'
        : textoLimpo;

    const timestamp = Date.now();
    const mp3Path = path.join(TEMP_DIR, `tts_${timestamp}.mp3`);

    try {
        console.log(`🔊 Gerando áudio TTS Google (${textoFinal.length} chars)...`);

        const encoded = encodeURIComponent(textoFinal);
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=pt-BR&client=tw-ob&ttsspeed=0.9`;

        await downloadToFile(url, mp3Path);

        // Verifica se o arquivo tem conteúdo real (MP3 vazio = falhou silenciosamente)
        if (!fs.existsSync(mp3Path)) {
            throw new Error('Arquivo MP3 não foi criado.');
        }
        const { size } = fs.statSync(mp3Path);
        if (size < 200) {
            throw new Error(`Arquivo muito pequeno (${size} bytes) — possível bloqueio.`);
        }

        console.log(`✅ Áudio TTS gerado: ${mp3Path} (${size} bytes)`);
        return mp3Path;

    } catch (error) {
        console.error('❌ Erro ao gerar áudio TTS:', error);
        if (fs.existsSync(mp3Path)) {
            try { fs.unlinkSync(mp3Path); } catch (_) { }
        }
        return null;
    }
}

/**
 * Remove arquivo de áudio temporário após envio.
 */
export function limparAudioTemp(filePath: string): void {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (_) {
        // ignora
    }
}
