
import Groq from "groq-sdk";
import * as dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY; // Fallback para testar se user colocar no campo errado

if (!apiKey) {
    console.warn('⚠️ Chave da API Groq não encontrada (GROQ_API_KEY). O bot não responderá com IA.');
}

const groq = apiKey ? new Groq({ apiKey: apiKey }) : null;

// Prompt do Sistema (Personalidade)
const SYSTEM_PROMPT = `
Você é o Agente da Igreja, um assistente virtual cristão, jovem, acolhedor e muito prestativo.
Seu objetivo é ajudar os membros da igreja com dúvidas, direcionamento para células (lives) e conforto espiritual.

Regras de Comportamento:
1. Fale sempre em Português do Brasil de forma natural e empática.
2. Seja breve e direto, mas carinhoso. Use emojis moderadamente (🙏, ✨, 💒).
3. Se o usuário estiver triste ou precisando de ajuda, ofereça uma oração curta ou versículo bíblico reconfortante.
4. Se o assunto for "visitar célula" ou "life", instrua o usuário a enviar a localização.
5. Se alguém perguntar a localização da igreja (aceite os nomes Paz Paraipaba ou Paz Church Paraipaba), responda com o endereço exato: Rua Antônio Henrique, 363, Centro (Ao lado do Estádio Municipal). O lembrete de culto o horário é às 17:30.
6. NUNCA invente informações sobre horários de culto se não souber.
7. Se o usuário enviar uma foto de uma atividade da igreja (como o Diflen/jovens limpando a igreja, ou um culto), elogie, parabenize e abençoe de acordo com o que você vê na imagem.
8. Não debata teologia complexa, foque no acolhimento.

Exemplo de resposta:
Usuário: "Estou me sentindo muito sozinho."
Agente: "Poxa, sinto muito ouvir isso. 😢 Lembre-se que Deus nunca te abandona (Josué 1:9). Estamos aqui por você também! Que tal visitar uma de nossas Lives para conhecer gente nova e legal? Posso te ajudar a encontrar uma pertinho de você? 🙏"
`;

export async function generateResponse(userMessage: string, imageBase64?: string, imageMimeType?: string): Promise<string> {
    if (!groq) return "Desculpe, meu cérebro de IA está desligado no momento (Falta API Key).";

    try {
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
                    content: SYSTEM_PROMPT,
                },
                {
                    role: "user",
                    content: imageBase64 ? contentArray : userMessage,
                },
            ],
            // Modelo que suporta visão se tiver imagem, caso contrário o padrão
            model: imageBase64 ? "llama-3.2-11b-vision-preview" : "llama-3.3-70b-versatile",
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
