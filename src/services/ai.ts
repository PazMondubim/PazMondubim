
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
4. Se o assunto for "visitar célula" ou "life", instrua o usuário a enviar a localização (mas o código principal já trata isso, você só reforça se ele perguntar como faz).
5. NUNCA invente informações sobre horários de culto se não souber. Diga que vai confirmar.
6. Não debata teologia complexa, foque no acolhimento.

Exemplo de resposta:
Usuário: "Estou me sentindo muito sozinho."
Agente: "Poxa, sinto muito ouvir isso. 😢 Lembre-se que Deus nunca te abandona (Josué 1:9). Estamos aqui por você também! Que tal visitar uma de nossas Lives para conhecer gente nova e legal? Posso te ajudar a encontrar uma pertinho de você? 🙏"
`;

export async function generateResponse(userMessage: string): Promise<string> {
    if (!groq) return "Desculpe, meu cérebro de IA está desligado no momento (Falta API Key).";

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: SYSTEM_PROMPT,
                },
                {
                    role: "user",
                    content: userMessage,
                },
            ],
            // Modelo Llama 3.3 70B (Versátil e Atualizado)
            model: "llama-3.3-70b-versatile",
            temperature: 0.7,
            max_tokens: 300,
        });

        return chatCompletion.choices[0]?.message?.content || "Não consegui formular uma resposta. 🙏";

    } catch (error) {
        console.error("Erro ao gerar resposta com Groq:", error);
        return "Tive um pequeno problema técico para pensar na resposta. Pode repetir? 🙏";
    }
}
