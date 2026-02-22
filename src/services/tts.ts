/**
 * Serviço de Text-to-Speech (TTS) GRATUITO
 * Usa a API do Microsoft Edge TTS via edge-tts-node.
 * Voz: pt-BR-FranciscaNeural (voz feminina brasileira natural)
 */

import * as fs from 'fs';
import * as path from 'path';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'edge-tts-node';

// Voz brasileira feminina natural da Microsoft (gratuita)
const VOICE_PT_BR = 'pt-BR-FranciscaNeural';

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
        // Remove emojis (bloco amplo de unicode)
        .replace(/[\u{1F000}-\u{1FFFF}|\u{2600}-\u{27BF}|\u{2300}-\u{23FF}|\u{2B00}-\u{2BFF}|\u{FE00}-\u{FEFF}]/gu, '')
        // Remove asteriscos de formatação bold do WhatsApp
        .replace(/\*/g, '')
        // Remove underline de itálico
        .replace(/_/g, ' ')
        // Reduz múltiplas quebras de linha
        .replace(/\n{2,}/g, '. ')
        .replace(/\n/g, '. ')
        .trim();
}

/**
 * Converte texto em arquivo de áudio MP3 usando Microsoft Edge TTS (gratuito).
 * Retorna o caminho do arquivo gerado, ou null em caso de erro.
 */
export async function textToSpeech(texto: string): Promise<string | null> {
    const textoLimpo = limparTextoParaTTS(texto);

    if (!textoLimpo || textoLimpo.length < 3) {
        return null;
    }

    // Limita o texto a 500 caracteres para não gerar áudios muito longos
    const textoFinal = textoLimpo.length > 500
        ? textoLimpo.substring(0, 497) + '...'
        : textoLimpo;

    const timestamp = Date.now();
    const mp3Path = path.join(TEMP_DIR, `tts_${timestamp}.mp3`);

    try {
        console.log(`🔊 Gerando áudio TTS (${textoFinal.length} chars)...`);

        // Instancia o cliente Edge TTS (objeto de configuração vazio é obrigatório)
        const tts = new MsEdgeTTS({});

        // Configura a voz e o formato de saída (MP3 96kbps)
        await tts.setMetadata(VOICE_PT_BR, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);

        // Gera o arquivo de áudio
        await tts.toFile(mp3Path, textoFinal);

        // Fecha a conexão WebSocket do TTS
        tts.close();

        if (!fs.existsSync(mp3Path)) {
            throw new Error('Arquivo MP3 não foi gerado pelo TTS.');
        }

        console.log(`✅ Áudio TTS gerado: ${mp3Path}`);
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
        // Ignora erros ao limpar
    }
}
