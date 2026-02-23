
import Groq from "groq-sdk";
import * as dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY; // Fallback para testar se user colocar no campo errado

if (!apiKey) {
    console.warn('⚠️ Chave da API Groq não encontrada (GROQ_API_KEY). O bot não responderá com IA.');
}

const groq = apiKey ? new Groq({ apiKey: apiKey }) : null;

// Prompt do Sistema (Personalidade)
import { getActiveFeaturesForPrompt } from '../config/botConfig';

const SYSTEM_PROMPT = `
Você é o Agente da Igreja, um assistente virtual cristão da Paz Church Paraipaba/Trairi.
Sua missão principal é ajudar os membros com dúvidas, doações diárias, aconselhamento bíblico e acolhimento espiritual.

MÓDULOS ATIVOS QUE VOCÊ DEVE SUPORTAR E AVISAR AO USUÁRIO QUE SABE FAZER SE DEMANDADO:
[DYNAMIC_FEATURES]

Regras de Comportamento e Configuração Atual:
1. Fale sempre natural e empático (Português do Brasil).
2. Pode usar gírias jovens se as features ativas permitirem ou se o pastor configurou. Use emojis moderadamente (🙏, ✨, 💒).
3. Se o assunto for "visitar célula" ou "life", instrua o usuário a clicar no clipe e enviar a localização atual dele.
4. O endereço exato é: Rua Antônio Henrique, 363, Centro (Ao lado do Estádio Municipal). O culto é domingo às 17h30.
5. Quando requisitado para realizar uma das ações marcadas em [ON] nos módulos ativos, execute seu papel respondendo de acordo (Ex: se for formatar sermão para PDF, faça a revisão impecável do texto, se for responder na central de consolo de luto, aja com profunda reverência).
6. Se perguntarem se vc sabe fazer X e não estiver nos módulos ativos, diga que no momento o Pastor desligou essa função.
`;

export async function generateResponse(userMessage: string, imageBase64?: string, imageMimeType?: string): Promise<string> {
    if (!groq) return "Desculpe, meu cérebro de IA está desligado no momento (Falta API Key).";

    try {
        const dynamicPrompt = SYSTEM_PROMPT.replace('[DYNAMIC_FEATURES]', getActiveFeaturesForPrompt());

        let contentArray: any[] = [{ type: "text", text: userMessage }];

        if (imageBase64 && imageMimeType) {
            contentArray.push({
                type: "image_url",
                image_url: {
                    url: `data:${imageMimeType};base64,${imageBase64}`,
                },
            });
        }

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: dynamicPrompt,
                },
                {
                    role: "user",
                    content: imageBase64 ? contentArray : userMessage,
                },
            ],
            // Modelo que suporta visão se tiver imagem, caso contrário o padrão
            // llama-4-scout suporta multimodal (texto + imagem) e é o substituto recomendado pela Groq
            model: imageBase64 ? "meta-llama/llama-4-scout-17b-16e-instruct" : "llama-3.3-70b-versatile",
            temperature: 0.7,
            max_tokens: 500,
        });

        return chatCompletion.choices[0]?.message?.content || "Não consegui formular uma resposta. 🙏";

    } catch (error) {
        console.error("Erro ao gerar resposta com Groq:", error);
        return "Tive um pequeno problema técico para pensar na resposta. Pode repetir? 🙏";
    }
}

export async function transcribeAudio(audioFileStream: any): Promise<string> {
    if (!groq) return "";

    try {
        const transcription = await groq.audio.transcriptions.create({
            file: audioFileStream,
            model: "whisper-large-v3-turbo",
            response_format: "text",
            language: "pt"
        });
        return typeof transcription === "string" ? transcription : (transcription as any).text || "";
    } catch (error) {
        console.error("Erro na transcrição de áudio com Groq:", error);
        return "";
    }
}
