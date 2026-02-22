/**
 * Serviço de Text-to-Speech (TTS) GRATUITO
 * Usa a API do Microsoft Edge TTS - sem custo, sem limites.
 * Voz: pt-BR-FranciscaNeural (voz feminina brasileira natural)
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Verifica se edge-tts-node está disponível
let EdgeTTS: any;
try {
    EdgeTTS = require('edge-tts-node');
} catch (e) {
    console.warn('⚠️ edge-tts-node não encontrado. Respostas de áudio desabilitadas.');
}

// Voz brasileira feminina natural da Microsoft (gratuita)
const VOICE_PT_BR = 'pt-BR-FranciscaNeural';
// Alternativas: 'pt-BR-AntonioNeural' (masculino), 'pt-BR-BrendaNeural'

// Pasta temporária para áudios gerados
const TEMP_DIR = path.join(__dirname, '../../temp_tts');

// Garante que a pasta temporária existe
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Limpa emojis e caracteres especiais do texto antes de sintetizar.
 * O TTS não soa bem com emojis lidos como texto.
 */
function limparTextoParaTTS(texto: string): string {
    return texto
        // Remove emojis
        .replace(/[\u{1F600}-\u{1F64F}|\u{1F300}-\u{1F5FF}|\u{1F680}-\u{1F6FF}|\u{2600}-\u{26FF}|\u{2700}-\u{27BF}|\u{1F900}-\u{1F9FF}|\u{1FA00}-\u{1FA6F}|\u{1FA70}-\u{1FAFF}|\u{231A}-\u{231B}|\u{23E9}-\u{23F3}|\u{23F8}-\u{23FA}|\u{25AA}-\u{25AB}|\u{25B6}|\u{25C0}|\u{25FB}-\u{25FE}|\u{2614}-\u{2615}|\u{2648}-\u{2653}|\u{267F}|\u{2693}|\u{26A1}|\u{26AA}-\u{26AB}|\u{26BD}-\u{26BE}|\u{26C4}-\u{26C5}|\u{26CE}|\u{26D4}|\u{26EA}|\u{26F2}-\u{26F3}|\u{26F5}|\u{26FA}|\u{26FD}|\u{2702}|\u{2705}|\u{2708}-\u{270D}|\u{270F}|\u{2712}|\u{2714}|\u{2716}|\u{271D}|\u{2721}|\u{2728}|\u{2733}-\u{2734}|\u{2744}|\u{2747}|\u{274C}|\u{274E}|\u{2753}-\u{2755}|\u{2757}|\u{2763}-\u{2764}|\u{2795}-\u{2797}|\u{27A1}|\u{27B0}|\u{27BF}|\u{2934}-\u{2935}|\u{2B05}-\u{2B07}|\u{2B1B}-\u{2B1C}|\u{2B50}|\u{2B55}|\u{3030}|\u{303D}|\u{3297}|\u{3299}]/gu, '')
        // Remove asteriscos de formatação bold do WhatsApp
        .replace(/\*/g, '')
        // Remove underline de itálico
        .replace(/_/g, ' ')
        // Reduz múltiplas quebras de linha a uma
        .replace(/\n{2,}/g, '\n')
        .trim();
}

/**
 * Converte texto em arquivo de áudio OGG (formato suportado pelo WhatsApp).
 * Retorna o caminho do arquivo gerado, ou null em caso de erro.
 */
export async function textToSpeech(texto: string): Promise<string | null> {
    if (!EdgeTTS) {
        console.warn('⚠️ TTS não disponível.');
        return null;
    }

    const textoLimpo = limparTextoParaTTS(texto);

    if (!textoLimpo || textoLimpo.length < 3) {
        return null;
    }

    // Limita o texto a 500 caracteres para não gerar áudios muito longos
    const textoFinal = textoLimpo.length > 500
        ? textoLimpo.substring(0, 500) + '...'
        : textoLimpo;

    const timestamp = Date.now();
    const mp3Path = path.join(TEMP_DIR, `tts_${timestamp}.mp3`);
    const oggPath = path.join(TEMP_DIR, `tts_${timestamp}.ogg`);

    try {
        console.log(`🔊 Gerando áudio TTS (${textoFinal.length} chars)...`);

        // Gera o MP3 com Edge TTS
        const tts = new EdgeTTS();
        await tts.ttsPromise(textoFinal, mp3Path, VOICE_PT_BR);

        // Converte MP3 → OGG Opus (formato de voz do WhatsApp)
        // Tenta com ffmpeg se disponível
        try {
            await execAsync(`ffmpeg -y -i "${mp3Path}" -c:a libopus -b:a 24k "${oggPath}" 2>/dev/null`);
            fs.unlinkSync(mp3Path); // Remove MP3 temporário
            console.log(`✅ Áudio TTS gerado: ${oggPath}`);
            return oggPath;
        } catch (ffmpegErr) {
            // Se ffmpeg não estiver disponível, usa o MP3 direto
            // WhatsApp aceita MP3 como audioMessage mas não como voz (ptt)
            console.warn('⚠️ ffmpeg não encontrado, usando MP3 diretamente (sem codec opus).');
            console.log(`✅ Áudio TTS gerado (MP3): ${mp3Path}`);
            return mp3Path;
        }

    } catch (error) {
        console.error('❌ Erro ao gerar áudio TTS:', error);
        // Limpa arquivos temporários se existirem
        if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
        if (fs.existsSync(oggPath)) fs.unlinkSync(oggPath);
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
    } catch (e) {
        // Ignora erros ao limpar
    }
}
