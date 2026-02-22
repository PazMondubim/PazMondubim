import { default as makeWASocket, useMultiFileAuthState, DisconnectReason, WASocket, WAMessage, proto, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { supabase } from '../config/supabase';
import { findNearestLife } from '../utils/location';

export class WhatsAppService {
    public sock: WASocket | undefined;
    // Alterado para evitar conflito com a pasta antiga que pode estar corrompida/travada
    private authStateStr = 'auth_session_v2';
    private retryCount = 0;
    private MAX_RETRIES = 5;

    public qrCodeString: string | null = null;
    public isConnected: boolean = false;
    private LEADER_PHONE = process.env.LEADER_PHONE; // Melhoria 12

    // Controle de estado para cadastro completo
    // Estados: WAITING_NAME -> WAITING_PHONE -> WAITING_BIRTHDATE -> WAITING_NEIGHBORHOOD -> WAITING_LIFE_GROUP -> null
    private registrationStates: {
        [key: string]: {
            step: 'WAITING_NAME' | 'WAITING_PHONE' | 'WAITING_EMAIL' | 'WAITING_CEP' | 'WAITING_ADDRESS' | 'WAITING_BIRTHDATE' | 'WAITING_LIFE_GROUP',
            data: any
        }
    } = {};

    constructor() {
    }

    async connectToWhatsApp() {
        console.log('🔄 Iniciando conexão com WhatsApp...');

        try {
            const { state, saveCreds } = await useMultiFileAuthState(this.authStateStr);
            console.log('📂 Estado de autenticação recriado.');

            this.sock = makeWASocket({
                logger: pino({ level: 'silent' }), // Voltei para silent para não poluir
                auth: state,
                printQRInTerminal: true, // Voltei para true para garantir que o QR apareça no terminal se o navegador falhar
                syncFullHistory: false, // Menos uso de recursos / Menos chance de travar ao sincronizar tudo
                markOnlineOnConnect: true, // Força status online
                keepAliveIntervalMs: 30000, // Mantém a conexão websocket ativa por mais tempo
            });

            this.sock.ev.on('connection.update', (update: any) => {
                const { connection, lastDisconnect, qr } = update;
                console.log(`📡 Atualização de Conexão: ${connection || 'Indefinido'} | QR: ${qr ? 'SIM' : 'NÃO'}`);

                if (qr) {
                    this.qrCodeString = qr;
                    this.isConnected = false;
                    console.log('\n==================================================================');
                    console.log('📌 QR CODE GERADO! (Se não aparecer, acesse /qr no navegador)');
                    console.log('==================================================================\n');

                    // Gera QR Code pequeno no terminal (melhor para logs)
                    qrcode.generate(qr, { small: true });
                }

                if (connection === 'close') {
                    const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                    // Correção 9: Tratamento específico para conexão substituída
                    if (statusCode === DisconnectReason.connectionReplaced) {
                        console.error('❌ Conexão substituída por outra sessão aberta. Não tentarei reconectar automaticamente para evitar conflito.');
                        this.sock?.end(undefined);
                        return;
                    }

                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    console.log(`❌ Conexão fechada. Status Code: ${statusCode} | Motivo: ${(lastDisconnect?.error as Error)?.message}`);

                    // Correção 1: Evitar loop infinito com limite de tentativas
                    if (statusCode === 405 || statusCode === 401) {
                        console.log('⚠️ Erro crítico de autenticação (405/401).');
                        // Forçar limpeza imediata
                        const authPath = path.resolve(this.authStateStr);
                        try {
                            if (fs.existsSync(authPath)) {
                                console.log('🧹 Limpando sessão corrompida...');
                                fs.rmSync(authPath, { recursive: true, force: true });
                            }
                        } catch (e) {
                            console.error('Erro ao limpar pasta (pode estar em uso):', e);
                            // Se não der pra apagar, tenta mudar o nome dinamicamente na próxima (fallback)
                            this.authStateStr = `auth_session_${Date.now()}`;
                        }

                        console.log('🔄 Reiniciando conexão em 5 segundos...');
                        setTimeout(() => this.connectToWhatsApp(), 5000);

                    } else if (shouldReconnect) {
                        this.retryCount++;
                        console.log(`🔄 Tentando reconectar em 5 segundos... (Tentativas: ${this.retryCount})`);
                        // Removemos o limite de retries porque sem internet no celular principal, 
                        // a conexão com o servidor do Baileys ainda pode oscilar e ele NÃO deve desligar!
                        setTimeout(() => this.connectToWhatsApp(), 5000);
                    }
                } else if (connection === 'open') {
                    console.log('✅ Conectado ao WhatsApp com sucesso!');
                    this.qrCodeString = null;
                    this.isConnected = true;
                    this.retryCount = 0; // Resetar contador ao conectar sucesso
                }
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('messages.upsert', async (m: any) => {
                const msg = m.messages[0];
                if (!msg.message || m.type !== 'notify') return;

                const remoteJid = msg.key.remoteJid;
                // Correção 8: Ignorar mensagens editadas (protocolMessage com editedMessage)
                if (msg.message.protocolMessage?.type === proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING ||
                    msg.message.editedMessage) {
                    return;
                }

                if (!remoteJid) return;

                // Correção 17: Ignorar status broadcast
                if (remoteJid === 'status@broadcast') return;

                const fromMe = msg.key.fromMe;
                if (fromMe) return;

                // --- DEBUG TOTAL ---
                console.log('\n=======================================');
                console.log('📩 MENSAGEM RECEBIDA!');
                console.log(`🆔 JID: ${remoteJid}`);
                console.log(`👤 É de arquivo/status? ${msg.key.remoteJid === 'status@broadcast' ? 'SIM' : 'NÃO'}`);

                let textBody = msg.message.conversation || msg.message.extendedTextMessage?.text;
                let imageBase64: string | undefined;
                let imageMimeType: string | undefined;

                // Tratamento de Mídia (Imagens)
                if (msg.message.imageMessage) {
                    console.log('🖼️ Imagem recebida!');
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: this.sock?.updateMediaMessage } as any);
                        imageBase64 = (buffer as Buffer).toString('base64');
                        imageMimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
                        textBody = msg.message.imageMessage.caption || "Analise esta foto por favor e reaja como a instrução manda.";
                    } catch (err) {
                        console.error("Erro ao baixar imagem:", err);
                        await this.sendMessage(remoteJid, "Não consegui visualizar sua foto direito. Tem como tentar de novo? 🙏");
                        return;
                    }
                }

                // Tratamento de Mídia (Áudio)
                if (msg.message.audioMessage) {
                    console.log('🎤 Áudio recebido!');
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: this.sock?.updateMediaMessage } as any);
                        const audioPath = path.join(__dirname, `../../temp_audio_${Date.now()}.ogg`);
                        fs.writeFileSync(audioPath, (buffer as Buffer));

                        const { transcribeAudio } = await import('./ai');

                        if (this.sock) {
                            await this.sock.sendPresenceUpdate('recording', remoteJid);
                        }

                        const textFromAudio = await transcribeAudio(fs.createReadStream(audioPath));
                        fs.unlinkSync(audioPath); // remover o arquivo depois

                        if (textFromAudio) {
                            textBody = textFromAudio;
                            console.log(`🗣️ Transcrição do áudio: ${textBody}`);
                        } else {
                            await this.sendMessage(remoteJid, "Não consegui entender muito bem o áudio. Pode digitar? 🙏");
                            return;
                        }

                    } catch (err) {
                        console.error("Erro ao transcrever áudio:", err);
                        await this.sendMessage(remoteJid, "Deu erro para escutar seu áudio agora, me mande por texto se puder. 🙏");
                        return;
                    }
                }

                console.log(`📝 Texto: ${textBody || '[Sem Texto]'}`);
                console.log('=======================================\n');

                if (textBody) {
                    const lowerText = textBody.toLowerCase();

                    // Pegar o telefone real, ignorando sufixos e tratando LID (Linked Device ID)
                    let phone = remoteJid.replace(/\D/g, '');

                    if (remoteJid.includes('@lid')) {
                        console.warn('⚠️ Recebido mensagem de um ID de dispositivo (LID).');
                        // Tentar usar o ID numérico mesmo assim, ou ignorar.
                        // Melhor: tentar pegar o número real se o Baileys expuser
                        try {
                            // Verifica se o usuário mandou mensagem e tem JID real no 'me'
                            const realJid = this.sock?.user?.id.split(':')[0]; // Ex: 558599...
                            // Mas isso é o MEU numero. O do usuário é mais difícil.
                            // Vou manter o ID do LID no LOG para o usuário cadastrar O LID se for o caso.
                            console.log(`💡 DICA: Se este número não for reconhecido, cadastre o ID ${phone} no banco de dados temporariamente.`);
                        } catch (e) { }
                    }

                    // Se a mensagem tiver `participant` e não for grupo, usa ele
                    // (Em 1x1 participant costuma ser undefined, mas vale checar)
                    if (msg.key.participant) {
                        const realUser = msg.key.participant.split('@')[0];
                        if (!msg.key.participant.includes('@lid')) {
                            console.log(`💡 Descoberto telefone real via participant: ${realUser}`);
                            phone = realUser;
                        }
                    }

                    // 📢 LOG CONFIRMAÇÃO DE GRUPO
                    if (remoteJid?.includes('@g.us')) {
                        console.log(`✅ GRUPO IDENTIFICADO: ${remoteJid}`);
                    }

                    if (remoteJid?.includes('@g.us')) return; // Ignora grupos

                    // --- FLUXO DE CADASTRO AUTOMÁTICO (Máquina de Estados) ---

                    const currentState = this.registrationStates[remoteJid];

                    if (currentState) {
                        // 1. Processando NOME
                        if (currentState.step === 'WAITING_NAME') {
                            const name = textBody.trim();
                            if (name.length < 3) {
                                await this.sendMessage(remoteJid, "Nome muito curto. Por favor, digite seu nome completo amor. 😊");
                                return;
                            }

                            currentState.data.name = name;
                            currentState.step = 'WAITING_PHONE';
                            await this.sendMessage(remoteJid, `Prazer, *${name}*! 👋\n\nAgora, me conta: *Qual é o seu número de telefone/WhatsApp principal?* 📱\n(Se for este mesmo que você está usando, pode digitar apenas "Este")`);
                            return;
                        }

                        // 2. Processando TELEFONE
                        if (currentState.step === 'WAITING_PHONE') {
                            const inputPhone = textBody.trim();

                            if (inputPhone.toLowerCase().includes('este') || inputPhone.toLowerCase().includes('esse')) {
                                // Pega o ID do remetente (ex: 558599998888@s.whatsapp.net) e remove o sufixo
                                currentState.data.phone_contact = phone.replace('@s.whatsapp.net', '').replace('@c.us', '');
                            } else {
                                // Remove caracteres não numéricos
                                const cleaned = inputPhone.replace(/\D/g, '');
                                // Correção 12: Validação de formato do telefone
                                if (cleaned.length < 10 || cleaned.length > 13) {
                                    await this.sendMessage(remoteJid, "Hmm, esse número parece inválido. 🤔 Digite o DDD + Número (ex: 85999998888).");
                                    return;
                                }
                                currentState.data.phone_contact = cleaned;
                            }

                            currentState.step = 'WAITING_EMAIL';
                            await this.sendMessage(remoteJid, `Anotado! 📞\n\nAgora, qual é o seu *E-mail*? 📧`);
                            return;
                        }

                        // 3. Processando EMAIL
                        if (currentState.step === 'WAITING_EMAIL') {
                            const email = textBody.trim();
                            currentState.data.email = email;

                            currentState.step = 'WAITING_CEP';
                            await this.sendMessage(remoteJid, `Perfeito! 📧\n\nQual é o seu *CEP*? (Somente números) 📮`);
                            return;
                        }

                        // 4. Processando CEP
                        if (currentState.step === 'WAITING_CEP') {
                            const cep = textBody.replace(/\D/g, ''); // Remove não números

                            // Correção 2: Validação de CEP
                            if (cep.length !== 8) {
                                await this.sendMessage(remoteJid, "CEP inválido. 😕 O CEP deve ter exatamente 8 números. Tente novamente.");
                                return;
                            }

                            currentState.data.cep = cep;

                            currentState.step = 'WAITING_ADDRESS';
                            await this.sendMessage(remoteJid, `Ótimo! Agora digite seu *Endereço Completo* (Rua, Número e Bairro). 🏠`);
                            return;
                        }

                        // 5. Processando ENDEREÇO
                        if (currentState.step === 'WAITING_ADDRESS') {
                            const address = textBody.trim();
                            currentState.data.address = address;

                            currentState.step = 'WAITING_BIRTHDATE';
                            await this.sendMessage(remoteJid, `Entendido! �\n\nAgora: *Qual sua data de nascimento?* (Ex: 25/12/1990) �`);
                            return;
                        }

                        // 6. Processando DATANASCIMENTO
                        if (currentState.step === 'WAITING_BIRTHDATE') {
                            const dateParts = textBody.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);

                            if (!dateParts) {
                                await this.sendMessage(remoteJid, "Data inválida. 😢 Tente no formato dia/mês/ano (Ex: 10/05/1995).");
                                return;
                            }

                            const birthDate = `${dateParts[3]}-${dateParts[2]}-${dateParts[1]}`;
                            currentState.data.birth_date = birthDate;

                            currentState.step = 'WAITING_LIFE_GROUP';
                            await this.sendMessage(remoteJid, `Certinho! �\n\nÚltima pergunta: *Você já faz parte de algum Life Group (Célula)?* \nSe sim, qual? (Se não, responda "Não")`);
                            return;
                        }

                        // 7. Processando LIFE GROUP e FINALIZANDO
                        if (currentState.step === 'WAITING_LIFE_GROUP') {
                            const lifeGroupAnswer = textBody.trim();
                            currentState.data.life_group = lifeGroupAnswer;

                            // Salva TUDO no Supabase
                            const { error } = await supabase.from('members').insert([{
                                name: currentState.data.name,
                                phone: phone, // WhatsApp ID
                                phone_contact: currentState.data.phone_contact,
                                email: currentState.data.email,
                                cep: currentState.data.cep,
                                address: currentState.data.address,
                                birth_date: currentState.data.birth_date,
                                life_group: currentState.data.life_group,
                                // Campos legado/opcionais
                                neighborhood: currentState.data.address // Usando endereço como bairro temporariamente ou vice-versa
                            }]);

                            if (error) {
                                console.error('Erro ao cadastrar:', error);
                                await this.sendMessage(remoteJid, "Ops, tive um erro ao salvar seu cadastro. " + (error.message || ""));
                                delete this.registrationStates[remoteJid];
                            } else {
                                await this.sendMessage(remoteJid, `Cadastro concluído com sucesso! ✅\n\nSeja muito bem-vindo(a), *${currentState.data.name}*! 🙏\nSinta-se à vontade para conversar comigo sempre que quiser.`);
                                delete this.registrationStates[remoteJid];



                                // Melhoria 12: Notificar Líder
                                if (this.LEADER_PHONE) {
                                    const leaderMsg = `🆕 *Novo Membro Cadastrado!* 🆕\n\n👤 *Nome:* ${currentState.data.name}\n📞 *Tel:* ${currentState.data.phone_contact}\n🏠 *End:* ${currentState.data.address}\n\nEntre em contato para dar as boas-vindas!`;
                                    // Formatar numero do lider se nao tiver sufixo
                                    const leaderJid = this.LEADER_PHONE.includes('@') ? this.LEADER_PHONE : `${this.LEADER_PHONE}@s.whatsapp.net`;
                                    await this.sendMessage(leaderJid, leaderMsg);
                                }
                            }
                            return;
                        }
                    }

                    // 2. Se não está em cadastro, checa se é membro novo
                    // 2. Se não está em cadastro, checa se é membro novo
                    // Tenta encontrar pelo telefone exato ou variações (com/sem 55)
                    const { data: member } = await supabase
                        .from('members')
                        .select('id, name')
                        .or(`phone.eq.${phone},phone.eq.${phone.replace(/^55/, '')},phone.eq.55${phone}`)
                        .maybeSingle(); // Usa maybeSingle para não estourar erro se tiver duplicado ou nada

                    if (!member && !currentState) {
                        const welcomeText =
                            `Oiiiiii!!! Que alegria ter você aqui na Paz Church Paraipaba e Trairi! 🤍
Somos uma igreja que vive a fé em Jesus, valoriza pessoas e caminha em família.

Desejamos que você se sinta em casa e encontre aqui um ambiente de cuidado, propósito e crescimento espiritual.
Conte conosco, sempre! 🙏

*Vamos fazer seu cadastro rapidinho para ficarmos conectados?*
Qual é o seu nome completo?`;

                        await this.sendMessage(remoteJid, welcomeText);
                        // Inicia o estado
                        this.registrationStates[remoteJid] = {
                            step: 'WAITING_NAME',
                            data: {}
                        };
                        return;
                    }

                    // ...segue o fluxo normal (comandos, IA)...

                    // Prioridade 1: Comandos Específicos
                    if (lowerText === '/reset') {
                        await supabase.from('members').delete().eq('phone', phone);
                        delete this.registrationStates[remoteJid];
                        await this.sendMessage(remoteJid, "Seu cadastro foi reiniciado! Mande um 'Oi' para começar de novo. 🔄");
                        return;
                    }

                    // Ponto 1: Menu Inicial Guiado
                    if (lowerText === 'oi' || lowerText === 'olá' || lowerText === 'ola' || lowerText === 'menu' || lowerText === '/ajuda' || lowerText === 'ajuda') {
                        const menuText = `Olá! Que bom falar com você! 👋\nComo posso te ajudar hoje?\n\n*Responda com o número da opção desejada:*\n\n1️⃣ Horários dos Cultos e Endereço\n2️⃣ Quero doar (Dízimos e Ofertas)\n3️⃣ Onde tem uma Life (Célula)?\n4️⃣ Falar com a Inteligência Artificial (Dúvidas/Aconselhamento)\n5️⃣ Falar com a Liderança / Pastor (Atendimento Humano)`;
                        await this.sendMessage(remoteJid, menuText);
                        return;
                    }

                    // Respostas Automáticas do Menu
                    if (lowerText === '1') {
                        await this.sendMessage(remoteJid, `📍 *Paz Church Paraipaba*\nRua Antônio Henrique, 363, Centro (Ao lado do Estádio Municipal)\n\n⏰ *Nossos Horários:*\nDomingo às 17h30\n\nEsperamos por você e sua família! �`);
                        return;
                    }

                    if (lowerText === '2' || lowerText.includes('doar') || lowerText.includes('dízimo') || lowerText.includes('oferta') || lowerText.includes('pix')) {
                        // Ponto 3: Módulo de Contribuições (PIX)
                        await this.sendMessage(remoteJid, `Que bênção! 🙏 Sua contribuição ajuda a expandir o Reino de Deus.\n\n📱 *Nossa Chave PIX (CNPJ)*:\n*56.895.009/0001-62*\n\nNome: Paz Church Paraipaba\n\n*"Cada um dê conforme determinou em seu coração, não com pesar ou por obrigação, pois Deus ama quem dá com alegria." - 2 Coríntios 9:7* 📖`);
                        return;
                    }

                    if (lowerText === '3' || lowerText.includes('life') || lowerText.includes('célula') || lowerText.includes('celula') || lowerText.includes('visitar')) {
                        // Ponto 4: Onde tem uma Life
                        await this.sendMessage(remoteJid, "Para eu encontrar a Life (Célula) mais próxima de você, por favor, clique no clipe 📎 aqui embaixo e me envie a sua *Localização Atual*. É rapidão! 📍");
                        return;
                    }

                    if (lowerText === '5' || lowerText.includes('falar com o pastor') || lowerText.includes('atendimento humano')) {
                        // Ponto 6: Atendimento Humano (Transbordo)
                        await this.sendMessage(remoteJid, "Compreendo. Estou transferindo o seu contato para a nossa Liderança/Pastor. Eles te responderão o mais rápido possível através deste mesmo número. 🙏");

                        if (this.LEADER_PHONE) {
                            const leaderJid = this.LEADER_PHONE.includes('@') ? this.LEADER_PHONE : `${this.LEADER_PHONE}@s.whatsapp.net`;
                            await this.sendMessage(leaderJid, `⚠️ *ATENDIMENTO HUMANO SOLICITADO* ⚠️\n\nO membro no número ${phone} pediu para falar com a Liderança.\nPor favor, responda a ele assim que possível.`);
                        }

                        return;
                    }

                    if (lowerText === '4') {
                        await this.sendMessage(remoteJid, "Pode falar! Do que você precisa? Estou aqui pra te ouvir e aconselhar usando a Palavra de Deus. ✨");
                        return;
                    }

                    // Prioridade 2: Conversa com IA (Gemini)
                    if (lowerText.length > 1) { // Reduzi para > 1 para captar "oi"
                        try {
                            const { generateResponse } = await import('./ai');

                            // Envia estado "digitando..."
                            if (this.sock) {
                                await this.sock.sendPresenceUpdate('composing', remoteJid);
                            }

                            const aiResponse = await generateResponse(textBody, imageBase64, imageMimeType);

                            // DEBUG: Verifique se o response vem vazio
                            if (!aiResponse) {
                                console.warn("IA retornou resposta vazia.");
                            } else {
                                await this.sendMessage(remoteJid, aiResponse);
                            }

                            // Para de "digitar"
                            if (this.sock) {
                                await this.sock.sendPresenceUpdate('available', remoteJid);
                            }

                        } catch (e) {
                            console.error("Erro na integração com IA:", e);
                            await this.sendMessage(remoteJid, "Estou com um pouquinho de sono (erro na IA). Tente já já! 😴");
                        }
                    }
                }

                // Tratamento de Localização
                if (msg.message.locationMessage) {
                    const { degreesLatitude, degreesLongitude } = msg.message.locationMessage;
                    console.log(`Recebida localização de ${remoteJid}: ${degreesLatitude}, ${degreesLongitude}`);

                    // Buscar Lives no Supabase
                    // Correção: Nome da tabela ajustado de 'lifes' para 'lives' conforme erro PGRST205
                    const { data: lives, error } = await supabase.from('lives').select('*');

                    if (error || !lives) {
                        console.error('Erro ao buscar lives:', error);
                        await this.sendMessage(remoteJid, "Desculpe, tive um problema ao consultar as Lives. Tente mais tarde.");
                        return;
                    }

                    const nearest = findNearestLife(degreesLatitude, degreesLongitude, lives);

                    if (nearest && nearest.distance < 50) { // Raio de 50km
                        const response = `📍 Encontrei uma Life próxima a você!\n\n*Nome:* ${nearest.name}\n*Líder:* ${nearest.leader_name} (${nearest.leader_phone})\n*Endereço:* ${nearest.address}\n*Dia:* ${nearest.meeting_day}\n\n*Distância:* ${nearest.distance.toFixed(2)}km`;
                        await this.sendMessage(remoteJid, response);
                    } else {
                        await this.sendMessage(remoteJid, "Poxa, não encontrei nenhuma Life cadastrada próxima à sua localização no momento.");
                    }
                }
            });
        } catch (err) {
            console.error('Erro fatal ao conectar no WhatsApp:', err);
        }
    }

    async sendMessage(to: string, text: string) {
        if (!this.sock) {
            console.warn('⚠️ WhatsApp não conectado ao tentar enviar mensagem.');
            return;
        }

        const delay = Math.floor(Math.random() * 3000) + 2000;
        await new Promise(resolve => setTimeout(resolve, delay));

        if (!to) {
            console.error('⚠️ Tentei enviar mensagem para número vazio/nulo.');
            return;
        }

        let jid = to;
        if (!jid.includes('@')) {
            // Se for numero curto (<= 13) é telefone normal --> @s.whatsapp.net
            // Se for longo (>= 14), suspeita de ser LID --> @lid
            if (jid.length >= 14) {
                jid = `${jid}@lid`;
                console.log(`🔧 Ajustando ID longo para sufixo @lid: ${jid}`);
            } else {
                jid = `${jid}@s.whatsapp.net`;
            }
        }

        console.log(`📤 Enviando texto para: ${jid}`);

        try {
            await this.sock.sendMessage(jid, { text });
            console.log(`✅ Texto enviado para ${jid}`);
        } catch (error) {
            console.error(`❌ Erro ao enviar para ${jid}:`, error);
            // Se falhou com @lid, tenta @s.whatsapp.net como fallback (e vice-versa é perigoso, melhor não)
        }
    }

    async sendImage(to: string, image: string | Buffer, caption: string) {
        if (!this.sock || !to) return;

        let jid = to;
        if (!jid.includes('@')) {
            if (jid.length >= 14) {
                jid = `${jid}@lid`;
            } else {
                jid = `${jid}@s.whatsapp.net`;
            }
        }

        try {
            const content = Buffer.isBuffer(image) ? { image } : { image: { url: image } };
            // Correção de caption: não pode ser undefined se tiver espaço
            const captionText = caption || '';

            await this.sock.sendMessage(jid, {
                ...content, // Passa objeto image
                caption: captionText
            });
        } catch (error) {
            console.error(`Erro ao enviar imagem para ${to}:`, error);
        }
    }
}

export const waService = new WhatsAppService();
