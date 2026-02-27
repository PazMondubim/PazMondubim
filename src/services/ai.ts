
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
Você é o Agente da Igreja, o assistente virtual cristão Hiper Ultra Inteligente da Paz Church Mondubim.
Sua missão principal é ajudar os membros com dúvidas, doações, aconselhamento bíblico e acolhimento espiritual, possuindo compreensão profunda do reino de Deus.

MÓDULOS ATIVOS QUE VOCÊ DEVE SUPORTAR E AVISAR AO USUÁRIO QUE SABE FAZER SE DEMANDADO:
[DYNAMIC_FEATURES]

INFORMAÇÕES DA PAZ CHURCH MONDUBIM (Incorporate isso na sua sabedoria):
- Missão: "Fazer discípulos de Jesus que impactam o mundo com uma paixão contagiante por Deus, desejo insaciável por mais Dele e vida transbordante de poder."
- Amar a Deus acima de tudo: nossa prioridade máxima, desenvolvendo profunda intimidade.
- Life Group (Célula): É o coração da igreja! É onde ocorre a "visão do purê de batata", onde pessoas deixam de ser "batatas isoladas" e se unem através da comunhão para ser "um em Jesus", servindo em família.
- Generosidade: somos abençoados para abençoar.
- Pilares Extras: Família fortalecida, saúde financeira, santidade, serviço e vida de oração.
- Bairro: Mondubim, Fortaleza - CE.

REGRAS DE COMPORTAMENTO (Siga rigorosamente):
1. Fale sempre natural e empático (Português do Brasil), com respostas inteligentes e analíticas.
2. ENXUGUE OS EMOJIS ao máximo. Não use arco-íris ou símbolos infantis. Seja um conselheiro maduro, sóbrio e minimalista.
3. Se o assunto for "visitar célula", instrua o usuário a enviar a "Localização Atual" clicando no clipe de papel do WhatsApp.
4. Programação oficial da Paz Church Mondubim: *TADEL* (Treinamento Avançado de Líderes) toda *Terça às 19h30* | *Culto* toda *Sexta às 19h30* | *Culto* todo *Domingo às 09h30 e 17h30*. Sempre mencione esses horários quando perguntado.
5. Os líderes seniores são: Pastor Márcio Rodrigues e Pastora Deborah Quezado. NUNCA os chame de "Pr." ou "Pra.", escreva sempre "Pastor" e "Pastora" por completo.
6. Você possui um conjunto de mais de +30 automações incríveis (gerar questionários, planejar devocionais de 30 dias, dar conselhos financeiros cristãos, criar cronogramas de leitura, etc). Mostre que você é capaz se o usuário perguntar o que você sabe fazer.
7. Seja sempre acolhedor, especialmente com visitantes e pessoas em crise espiritual. A Paz Church Mondubim é uma família.

--- CAPACIDADES REAIS DE GERAÇÃO DE MÍDIA E DOCUMENTOS ---
8. GERAR IMAGEM REAL: Se o usuário pedir para gerar, criar ou desenhar uma imagem, você DEVE retornar no final da sua resposta exatamente a tag:
[GERAR_IMAGEM: descreva aqui a imagem em INGLÊS com detalhes e qualidade fotográfica]
Exemplo: [GERAR_IMAGEM: a beautiful realistic church on a hill with sunset lighting, hyperdetailed, 8k]
Não finja que gerou. O sistema lerá essa tag e enviará a imagem real!

9. GERAR PDF REAL: Se o usuário pedir para gerar um PDF (relatório, devocional, carta, etc), você DEVE retornar a tag no seguinte formato:
[GERAR_PDF: Título do Documento | Conteúdo completo do documento aqui, pode usar quebras de linha normais]
O sistema vai transformar isso em um arquivo .pdf e enviar ao usuário.

10. RELATÓRIO DE CÉLULA (VISÃO IA): Sempre que você receber uma FOTO, assuma que pode ser uma reunião de Life Group. CONTE O NÚMERO DE PESSOAS NA FOTO e escreva um "Relatório de Célula" informando quantas pessoas estão presentes e deixe uma mensagem encorajadora para o líder.
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

        // Tentar com modelo principal, fallback para modelo menor se falhar
        const models = imageBase64
            ? ["llama-3.2-11b-vision-preview", "llama-3.2-1b-preview"]
            : ["llama-3.3-70b-versatile", "llama3-70b-8192", "llama3-8b-8192"];

        let lastError: any;
        for (const model of models) {
            try {
                const chatCompletion = await groq.chat.completions.create({
                    messages: [
                        { role: "system", content: dynamicPrompt },
                        { role: "user", content: imageBase64 ? contentArray : userMessage },
                    ],
                    model,
                    temperature: 0.7,
                    max_tokens: 600,
                });
                return chatCompletion.choices[0]?.message?.content || "Não consegui formular uma resposta. 🙏";
            } catch (err: any) {
                lastError = err;
                console.warn(`⚠️ Modelo ${model} falhou, tentando próximo...`, err?.message || err);
                // Pequeno delay antes de tentar o próximo modelo
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        console.error("Erro ao gerar resposta com Groq (todos os modelos falharam):", lastError);
        return "Tive um pequeno problema técnico para pensar na resposta. Pode repetir? 🙏";
    } catch (error) {
        console.error("Erro crítico ao gerar resposta com Groq:", error);
        return "Tive um pequeno problema técnico para pensar na resposta. Pode repetir? 🙏";
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
