import { default as makeWASocket, useMultiFileAuthState, DisconnectReason, WASocket, WAMessage, proto, downloadMediaMessage, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { supabase } from '../config/supabase';
import { findNearestLife } from '../utils/location';
import { textToSpeech, limparAudioTemp } from './tts';
import PDFDocument from 'pdfkit';

export class WhatsAppService {
    public sock: WASocket | undefined;
    // Alterado para evitar conflito com a pasta antiga que pode estar corrompida/travada
    private authStateStr = 'auth_session_v2';
    private retryCount = 0;
    private MAX_RETRIES = 999; // Reconectar infinitamente
    private reconnectTimer: NodeJS.Timeout | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private watchdogTimer: NodeJS.Timeout | null = null;
    private lastMessageAt: number = Date.now();
    private isReconnecting: boolean = false;

    public qrCodeString: string | null = null;
    public isConnected: boolean = false;
    private LEADER_PHONE = process.env.LEADER_PHONE; // Melhoria 12

    // Controle de estado para cadastro completo
    private registrationStates: {
        [key: string]: {
            step: 'WAITING_NAME' | 'WAITING_PHONE' | 'WAITING_EMAIL' | 'WAITING_CEP' | 'WAITING_ADDRESS' | 'WAITING_BIRTHDATE' | 'WAITING_LIFE_GROUP',
            data: any
        }
    } = {};

    constructor() {
        // Watchdog: verifica a cada 3 minutos se ainda está conectado
        this.watchdogTimer = setInterval(() => {
            if (!this.isConnected && !this.isReconnecting) {
                console.warn('🐕 WATCHDOG: Bot desconectado e sem reconexão em andamento. Forçando reconexão...');
                this.scheduleReconnect(0);
            } else if (this.isConnected) {
                // Testar se o socket ainda está ativo tentando enviar um ping (keepalive)
                const idleMs = Date.now() - this.lastMessageAt;
                if (idleMs > 10 * 60 * 1000) { // 10 minutos sem atividade
                    console.log(`💓 HEARTBEAT: ${Math.round(idleMs / 60000)} min sem mensagem. Verificando conexão...`);
                    try {
                        this.sock?.sendPresenceUpdate('available', 'status@broadcast').catch(() => {
                            console.warn('💔 HEARTBEAT falhou - conexão morta. Reconectando...');
                            this.isConnected = false;
                            this.scheduleReconnect(5000);
                        });
                    } catch (e) {
                        console.warn('💔 HEARTBEAT exception - reconectando...');
                        this.isConnected = false;
                        this.scheduleReconnect(5000);
                    }
                }
            }
        }, 3 * 60 * 1000); // a cada 3 minutos
    }

    private scheduleReconnect(delayMs: number) {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        // Backoff exponencial: quanto mais tentativas, maior o delay (máx 5 min)
        const backoffMs = Math.min(delayMs + (this.retryCount * 5000), 5 * 60 * 1000);
        console.log(`⏳ Reconectando em ${Math.round(backoffMs / 1000)}s... (tentativa ${this.retryCount + 1})`);
        this.isReconnecting = true;
        this.reconnectTimer = setTimeout(() => {
            this.isReconnecting = false;
            this.connectToWhatsApp();
        }, backoffMs);
    }

    async connectToWhatsApp() {
        console.log('🔄 Iniciando conexão com WhatsApp...');

        try {
            const { version, isLatest } = await fetchLatestBaileysVersion();
            console.log(`📡 Usando versão do WA v${version.join('.')}, isLatest: ${isLatest}`);
            const { state, saveCreds } = await useMultiFileAuthState(this.authStateStr);
            console.log('📂 Estado de autenticação recriado.');

            // Fecha socket anterior se existir
            if (this.sock) {
                try { this.sock.end(undefined); } catch (e) { }
                this.sock = undefined;
            }

            this.sock = makeWASocket({
                logger: pino({ level: 'silent' }),
                auth: state,
                version,
                syncFullHistory: false,
                markOnlineOnConnect: true,
                keepAliveIntervalMs: 25000, // Ping a cada 25s para manter conexão viva
                retryRequestDelayMs: 500,
                connectTimeoutMs: 60000, // 60s de timeout
                defaultQueryTimeoutMs: 60000,
                emitOwnEvents: false,
            });

            this.sock.ev.on('connection.update', (update: any) => {
                const { connection, lastDisconnect, qr } = update;
                console.log(`📡 Atualização de Conexão: ${connection || 'Indefinido'} | QR: ${qr ? 'SIM' : 'NÃO'}`);
                this.lastMessageAt = Date.now(); // Atualiza atividade

                if (qr) {
                    this.qrCodeString = qr;
                    this.isConnected = false;
                    console.log('\n==================================================================');
                    console.log('📌 QR CODE GERADO! (Se não aparecer, acesse /qr no navegador)');
                    console.log('==================================================================\n');
                    qrcode.generate(qr, { small: true });
                }

                if (connection === 'close') {
                    this.isConnected = false;
                    const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                    const reason = (lastDisconnect?.error as Error)?.message || 'Desconhecido';
                    console.log(`❌ Conexão fechada. Status Code: ${statusCode} | Motivo: ${reason}`);

                    // Conexão substituída por outra sessão - NÃO reconectar para evitar conflito
                    if (statusCode === DisconnectReason.connectionReplaced) {
                        console.error('❌ Conexão substituída por outra sessão aberta. Encerrando para evitar conflito.');
                        this.sock?.end(undefined);
                        return;
                    }

                    // Deslogado manualmente - não reconectar automaticamente
                    if (statusCode === DisconnectReason.loggedOut) {
                        console.error('🔴 Deslogado do WhatsApp. Escaneie o QR Code novamente.');
                        this.qrCodeString = null;
                        // Limpar sessão e reconectar para gerar novo QR
                        const authPath = path.resolve(this.authStateStr);
                        try {
                            if (fs.existsSync(authPath)) {
                                fs.rmSync(authPath, { recursive: true, force: true });
                                console.log('🧹 Sessão limpa. Aguardando novo QR Code...');
                            }
                        } catch (e) {
                            this.authStateStr = `auth_session_${Date.now()}`;
                        }
                        this.retryCount = 0;
                        this.scheduleReconnect(3000);
                        return;
                    }

                    // Erro crítico 405/401 - limpar sessão e reconectar
                    if (statusCode === 405 || statusCode === 401) {
                        console.log('⚠️ Erro crítico de autenticação (405/401). Limpando sessão...');
                        const authPath = path.resolve(this.authStateStr);
                        try {
                            if (fs.existsSync(authPath)) {
                                fs.rmSync(authPath, { recursive: true, force: true });
                            }
                        } catch (e) {
                            this.authStateStr = `auth_session_${Date.now()}`;
                        }
                        this.retryCount++;
                        this.scheduleReconnect(20000); // 20s no erro crítico
                        return;
                    }

                    // Qualquer outro motivo: reconectar com backoff exponencial (SEMPRE)
                    this.retryCount++;
                    this.scheduleReconnect(10000);

                } else if (connection === 'open') {
                    console.log('✅ Conectado ao WhatsApp com sucesso! (Paz Church Mondubim)');
                    this.qrCodeString = null;
                    this.isConnected = true;
                    this.retryCount = 0; // Resetar contador ao conectar com sucesso
                    this.lastMessageAt = Date.now();
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
                let isAudioMessage = false; // Flag para responder com áudio quando receber áudio
                if (msg.message.audioMessage) {
                    console.log('🎤 Áudio recebido! Vou transcrever e responder com áudio 🔊');
                    isAudioMessage = true;
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
                            await this.sendMessage(remoteJid, `Entendido! \n\nAgora: *Qual sua data de nascimento?* (Ex: 25/12/1990) `);
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
                            await this.sendMessage(remoteJid, `Certinho! \n\nÚltima pergunta: *Você já faz parte de algum Life Group (Célula)?* \nSe sim, qual? (Se não, responda "Não")`);
                            return;
                        }

                        // 7. Processando LIFE GROUP e FINALIZANDO
                        if (currentState.step === 'WAITING_LIFE_GROUP') {
                            const lifeGroupAnswer = textBody.trim();
                            currentState.data.life_group = lifeGroupAnswer;

                            // Salva TUDO no Supabase
                            const { error } = await supabase.from('members_mondubim').insert([{
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
                        .from('members_mondubim')
                        .select('id, name')
                        .or(`phone.eq.${phone},phone.eq.${phone.replace(/^55/, '')},phone.eq.55${phone}`)
                        .maybeSingle(); // Usa maybeSingle para não estourar erro se tiver duplicado ou nada

                    if (!member && !currentState) {
                        const welcomeText =
                            `Olá! Que alegria ter você aqui na Paz Church Mondubim! 🕊️
Somos uma família que vive a fé em Jesus, valoriza pessoas e caminha em comunidade.

Desejamos que você se sinta em casa. Conte conosco!

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
                        await supabase.from('members_mondubim').delete().eq('phone', phone);
                        delete this.registrationStates[remoteJid];
                        await this.sendMessage(remoteJid, "Seu cadastro foi reiniciado! Mande um 'Oi' para começar de novo. 🔄");
                        return;
                    }

                    // Ponto 1: Menu Inicial Guiado
                    if (lowerText === 'oi' || lowerText === 'olá' || lowerText === 'ola' || lowerText === 'menu' || lowerText === '/ajuda' || lowerText === 'ajuda') {
                        const menuText = `Olá! Que bom falar com você!\nComo posso te ajudar hoje?\n\n*Responda com o número da opção desejada:*\n\n1️⃣ Horários dos Cultos e Endereço\n2️⃣ Quero doar (Dízimos e Ofertas)\n3️⃣ Onde tem uma Life (Célula)?\n4️⃣ Falar com a Inteligência Artificial (Dúvidas/Aconselhamento)\n5️⃣ Falar com a Liderança / Pastor (Atendimento Humano)\n\n*Comandos Especiais:*\n!oração [seu pedido] - Enviar pedido de oração\n!presente - Registrar presença no culto\n!quiz - Jogar Quiz Bíblico`;
                        await this.sendMessage(remoteJid, menuText);
                        return;
                    }

                    // Respostas Automáticas do Menu
                    if (lowerText === '1') {
                        await this.sendMessage(remoteJid, `📍 *Paz Church Mondubim*\nBairro Mondubim, Fortaleza - CE\n\n⏰ *Nossa Programação Semanal:*\n\n📖 *Terça-feira* — TADEL (Treinamento Avançado de Líderes) às 19h30\n🔥 *Sexta-feira* — Culto às 19h30\n⛪ *Domingo* — Culto às 09h30 e às 17h30\n\nSiga-nos: @pazchurchmondubim\nEsperamos por você e sua família! 🙏`);
                        return;
                    }

                    if (lowerText === '2' || lowerText.includes('doar') || lowerText.includes('dízimo') || lowerText.includes('oferta') || lowerText.includes('pix')) {
                        // Ponto 3: Módulo de Contribuições (PIX)
                        await this.sendMessage(remoteJid, `Que bênção! 🙏 Sua contribuição ajuda a expandir o Reino de Deus.\n\n📱 *Nossa Chave PIX:*\n*(Confirme a chave PIX com a liderança pelo canal oficial)*\n\nNome: Paz Church Mondubim\n\n*"Cada um dê conforme determinou em seu coração, não com pesar ou por obrigação, pois Deus ama quem dá com alegria." - 2 Coríntios 9:7* 📖`);
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

                    // ==========================================
                    // 🙏 PEDIDO DE ORAÇÃO (!oração ou !oracao)
                    // ==========================================
                    if (lowerText.startsWith('!oração') || lowerText.startsWith('!oracao')) {
                        const pedido = textBody.replace(/^!oração\s*/i, '').replace(/^!oracao\s*/i, '').trim();

                        if (!pedido || pedido.length < 5) {
                            await this.sendMessage(remoteJid, "Por favor, escreva seu pedido após o comando.\nExemplo: *!oração pela saúde da minha mãe* 🙏");
                            return;
                        }

                        // Salva no Supabase (tabela prayer_requests)
                        const { error: dbErr } = await supabase.from('prayer_requests_mondubim').insert([{
                            phone,
                            member_name: member?.name || 'Anônimo',
                            request: pedido,
                            created_at: new Date().toISOString()
                        }]);

                        if (dbErr) {
                            console.warn('Tabela prayer_requests pode não existir ainda, pulando salvamento no DB:', dbErr.message);
                        }

                        // Confirma para o membro
                        await this.sendMessage(remoteJid, `🙏 *Seu pedido foi recebido!*\n\n"${pedido}"\n\nEstamos orando por você. \"O Senhor é o meu pastor; nada me faltará.\" - Salmos 23:1 💫`);

                        // Notifica o pastor com o pedido
                        if (this.LEADER_PHONE) {
                            const leaderJid = this.LEADER_PHONE.includes('@') ? this.LEADER_PHONE : `${this.LEADER_PHONE}@s.whatsapp.net`;
                            const leaderMsg = `🙏 *NOVO PEDIDO DE ORAÇÃO*\n\n*De:* ${member?.name || phone}\n*Pedido:* ${pedido}\n\nOre por este membro! 💫`;
                            await this.sendMessage(leaderJid, leaderMsg);
                        }
                        return;
                    }

                    // ==========================================
                    // ✅ CHECK-IN DE PRESENÇA (!presente)
                    // ==========================================
                    if (lowerText === '!presente' || lowerText === '!checkin' || lowerText === '!check-in') {
                        const now = new Date();
                        const diaSemana = now.getDay(); // 0 = Domingo

                        // Salva a presença no Supabase (tabela attendance)
                        const { error: attErr } = await supabase.from('attendance_mondubim').insert([{
                            phone,
                            member_name: member?.name || 'Anônimo',
                            checked_in_at: now.toISOString(),
                            day_of_week: diaSemana
                        }]);

                        if (attErr) {
                            console.warn('Tabela attendance pode não existir ainda:', attErr.message);
                        }

                        let resposta = '';
                        if (diaSemana === 0) {
                            // É domingo
                            resposta = `✅ *Presença registrada!*\n\nQue ótimo ter você aqui hoje, *${member?.name || 'irmão(a)'}*! 🔥\nQue este culto seja cheio da presença de Deus! 🙏👏`;
                        } else if (diaSemana === 2) {
                            // Terça-feira — TADEL
                            resposta = `✅ *Presença registrada!*\n\nSeja bem-vindo(a) ao *TADEL* desta semana, *${member?.name || 'líder'}*! 📖🔥\nQue Deus te capacite cada vez mais para liderar!`;
                        } else if (diaSemana === 5) {
                            // Sexta-feira — Culto
                            resposta = `✅ *Presença registrada!*\n\nQue bom ter você no culto de hoje, *${member?.name || 'irmão(a)'}*! 🙏🔥\nQue a presença de Deus te transforme!`;
                        } else {
                            resposta = `✅ *Presença registrada!*\n\nObrigado por registrar! 🙏\n\n📅 *Próximos encontros:*\nTerça - TADEL às 19h30\nSexta - Culto às 19h30\nDomingo - Culto às 09h30 e 17h30\n\nPaz Church Mondubim te espera! ⛪`;
                        }

                        await this.sendMessage(remoteJid, resposta);
                        return;
                    }

                    // ==========================================
                    // 💝 QUIZ BÍBLICO (!quiz)
                    // ==========================================
                    if (lowerText === '!quiz' || lowerText.startsWith('!quiz')) {
                        try {
                            const { generateResponse } = await import('./ai');

                            if (this.sock) await this.sock.sendPresenceUpdate('composing', remoteJid);

                            const quizPrompt = `Crie UMA pergunta de quiz bíblico divertida e educativa para um membro da igreja. 
Formato obrigatório:
📚 *Pergunta:* [pergunta aquí]

a) [opção]
b) [opção]
c) [opção]
d) [opção]

🔑 *Resposta:* [letra e explicação curta e divertida com versículo]

Faça perguntas variadas (pode ser sobre personagens bíblicos, versículos famosos, eventos do AT ou NT). Use emojis. Seja em Português do Brasil.`;

                            const quiz = await generateResponse(quizPrompt);

                            if (this.sock) await this.sock.sendPresenceUpdate('available', remoteJid);

                            if (quiz) {
                                await this.sendMessage(remoteJid, `🌟 *QUIZ BÍBLICO* 🌟\n\n${quiz}\n\n_Digite !quiz para uma nova pergunta!_ 😄`);
                            } else {
                                await this.sendMessage(remoteJid, "Ops! Não consegui gerar o quiz agora. Tente de novo! 😁");
                            }
                        } catch (e) {
                            console.error('Erro no quiz:', e);
                            await this.sendMessage(remoteJid, "Erro no quiz. Tente em instantes! 🙏");
                        }
                        return;
                    }

                    // ==========================================
                    // 📊 STATS DO PASTOR (!stats) - SÓ PARA O LIDER
                    // ==========================================
                    if (lowerText === '!stats' || lowerText === '!relatorio' || lowerText === '!relatório') {
                        // Verifica se é o pastor
                        const leaderClean = this.LEADER_PHONE?.replace(/\D/g, '') || '';
                        const isLeader = phone === leaderClean || phone.endsWith(leaderClean) || leaderClean.endsWith(phone);

                        if (!isLeader) {
                            await this.sendMessage(remoteJid, "Este comando é exclusivo da liderança. 🙏");
                            return;
                        }

                        try {
                            // Total de membros
                            const { count: totalMembers } = await supabase
                                .from('members_mondubim').select('*', { count: 'exact', head: true });

                            // Novos esta semana
                            const umaSemanaAtras = new Date();
                            umaSemanaAtras.setDate(umaSemanaAtras.getDate() - 7);
                            const { count: newThisWeek } = await supabase
                                .from('members_mondubim')
                                .select('*', { count: 'exact', head: true })
                                .gte('created_at', umaSemanaAtras.toISOString());

                            // Presenças esta semana
                            const { count: attendanceWeek } = await supabase
                                .from('attendance_mondubim')
                                .select('*', { count: 'exact', head: true })
                                .gte('checked_in_at', umaSemanaAtras.toISOString());

                            // Pedidos de oração pendentes
                            const { count: prayerCount } = await supabase
                                .from('prayer_requests_mondubim')
                                .select('*', { count: 'exact', head: true })
                                .gte('created_at', umaSemanaAtras.toISOString());

                            const dataHoje = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });

                            const stats = `📊 *RELATÓRIO DA IGREJA*\n_${dataHoje}_\n\n` +
                                `🧑\u200d💼 *Total de Membros:* ${totalMembers || 0}\n` +
                                `🌱 *Novos essa semana:* ${newThisWeek || 0}\n` +
                                `✅ *Check-ins essa semana:* ${attendanceWeek || 0}\n` +
                                `🙏 *Pedidos de oração (7d):* ${prayerCount || 0}\n\n` +
                                `🤖 Bot: ${waService.isConnected ? '🟢 Online' : '🔴 Offline'}\n\n` +
                                `_Glória a Deus! 🕊️_`;

                            await this.sendMessage(remoteJid, stats);

                        } catch (e) {
                            console.error('Erro ao gerar stats:', e);
                            await this.sendMessage(remoteJid, "Erro ao gerar relatório. Tente de novo.");
                        }
                        return;
                    }

                    // Prioridade 2: Conversa com IA
                    if (lowerText.length > 1) {
                        // Comando especial !audio para forçar resposta em áudio
                        let forcarAudio = false;
                        let textoParaIA = textBody;
                        if (lowerText.startsWith('!audio ')) {
                            forcarAudio = true;
                            textoParaIA = textBody.substring(7).trim();
                        }

                        try {
                            const { generateResponse } = await import('./ai');

                            // Envia estado "gravando" se for responder com áudio, "digitando" se for texto
                            if (this.sock) {
                                const presenceType = (isAudioMessage || forcarAudio) ? 'recording' : 'composing';
                                await this.sock.sendPresenceUpdate(presenceType, remoteJid);
                            }

                            let aiResponse = await generateResponse(textoParaIA, imageBase64, imageMimeType);

                            let sentMedia = false;

                            if (aiResponse) {
                                // 1. Verifica se deve gerar imagem
                                const matchImage = aiResponse.match(/\[GERAR_IMAGEM:\s*(.*?)\]/is);
                                if (matchImage) {
                                    const promptImg = matchImage[1].trim();
                                    aiResponse = aiResponse.replace(matchImage[0], '').trim();

                                    // Send the image with the rest of the text as caption
                                    if (this.sock) {
                                        try {
                                            const bodyOptions = JSON.stringify({ inputs: promptImg });
                                            const response = await fetch('https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell', {
                                                method: 'POST',
                                                headers: {
                                                    'Authorization': `Bearer ${process.env.HF_API_KEY}`,
                                                    'Content-Type': 'application/json'
                                                },
                                                body: bodyOptions
                                            });

                                            if (!response.ok) {
                                                throw new Error(`Servidor de imagem retornou erro: ${response.status} ${response.statusText}`);
                                            }

                                            const contentType = response.headers.get('content-type');
                                            if (!contentType || !contentType.startsWith('image/')) {
                                                throw new Error(`Esperado imagem, mas recebeu ${contentType}`);
                                            }

                                            const arrayBuffer = await response.arrayBuffer();
                                            const buffer = Buffer.from(arrayBuffer);

                                            await this.sock.sendMessage(remoteJid, {
                                                image: buffer,
                                                caption: aiResponse.length > 0 ? aiResponse : '✨ Imagem gerada com sucesso!'
                                            });
                                            sentMedia = true;
                                        } catch (e) {
                                            console.error('Erro ao baixar ou enviar imagem gerada:', e);
                                            // Fallback
                                            await this.sock.sendMessage(remoteJid, { text: aiResponse.length > 0 ? aiResponse : '✨ Imagem gerada com sucesso! (Tivemos problema com o renderizador visual)' });
                                        }
                                    }
                                }

                                // 2. Verifica se deve gerar PDF
                                const matchPdf = aiResponse.match(/\[GERAR_PDF:\s*(.*?)\s*\|\s*(.*?)\]/is);
                                if (matchPdf && !sentMedia) {
                                    const titlePdf = matchPdf[1].trim();
                                    const contentPdf = matchPdf[2].trim();
                                    aiResponse = aiResponse.replace(matchPdf[0], '').trim();

                                    // Create PDF
                                    const pdfPath = path.join(__dirname, `../../${Date.now()}.pdf`);
                                    const doc = new PDFDocument();
                                    doc.pipe(fs.createWriteStream(pdfPath));
                                    doc.fontSize(20).text(titlePdf, { align: 'center' });
                                    doc.moveDown();
                                    doc.fontSize(12).text(contentPdf);
                                    doc.end();

                                    // Wait for it to finish writing
                                    await new Promise((resolve) => setTimeout(resolve, 1500));

                                    if (this.sock) {
                                        let textToSend = aiResponse.length > 0 ? aiResponse : `📄 *${titlePdf}* gerado com sucesso!`;
                                        await this.sock.sendMessage(remoteJid, { text: textToSend });
                                        await this.sock.sendMessage(remoteJid, {
                                            document: fs.readFileSync(pdfPath),
                                            fileName: `${titlePdf}.pdf`,
                                            mimetype: 'application/pdf'
                                        });
                                        sentMedia = true;
                                    }

                                    // Clean up
                                    try { fs.unlinkSync(pdfPath); } catch (e) { }
                                }
                            }

                            if (!aiResponse && !sentMedia) {
                                console.warn("IA retornou resposta vazia.");
                            } else if ((isAudioMessage || forcarAudio) && !sentMedia && aiResponse) {
                                // 🔊 RESPONDER COM ÁUDIO (quando recebeu áudio OU quando usou !audio)
                                console.log('🔊 Gerando resposta em áudio...');
                                const audioFilePath = await textToSpeech(aiResponse);

                                if (audioFilePath) {
                                    await this.sendAudioMessage(remoteJid, audioFilePath);
                                    limparAudioTemp(audioFilePath);
                                } else {
                                    // Fallback: envia como texto se o áudio falhar
                                    console.warn('⚠️ TTS falhou, enviando como texto.');
                                    await this.sendMessage(remoteJid, aiResponse);
                                }
                            } else if (!sentMedia && aiResponse) {
                                // Resposta normal em texto
                                await this.sendMessage(remoteJid, aiResponse);
                            }

                            // Para de "digitar" / "gravar"
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

                    // --- CHECK-IN AUTOMÁTICO DE PRESENÇA NO DOMINGO ---
                    // Obter data/hora no fuso de São Paulo (GMT-3) de forma confiável
                    const d = new Date();
                    const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
                    const brTime = new Date(utc + (3600000 * -3));
                    const hour = brTime.getHours();
                    const minute = brTime.getMinutes();

                    // Check-in GPS automático nos dias/horários de culto:
                    // Domingo: 08h30-11h00 (culto manhã) e 16h30-20h00 (culto tarde)
                    // Sexta: 18h30-22h00 (culto)
                    // Terça: 18h30-22h00 (TADEL)
                    const isSunday = brTime.getDay() === 0;
                    const isFriday = brTime.getDay() === 5;
                    const isTuesday = brTime.getDay() === 2;
                    const isServiceTime =
                        (isSunday && ((hour >= 8 && hour < 11) || (hour >= 16 && hour < 20))) ||
                        (isFriday && hour >= 18 && hour < 22) ||
                        (isTuesday && hour >= 18 && hour < 22);

                    let eventName = 'Culto Dominical';
                    if (isTuesday) eventName = 'TADEL';
                    else if (isFriday) eventName = 'Culto de Sexta';
                    else if (isSunday && hour < 12) eventName = 'Culto da Manhã';

                    if (isServiceTime) {
                        // Coordenadas do bairro Mondubim, Fortaleza-CE
                        const churchLat = -3.8041;
                        const churchLng = -38.5874;

                        // Cálculo da distância em Km (Fórmula de Haversine)
                        const R = 6371;
                        const dLat = (degreesLatitude - churchLat) * (Math.PI / 180);
                        const dLng = (degreesLongitude - churchLng) * (Math.PI / 180);
                        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                            Math.cos(churchLat * (Math.PI / 180)) * Math.cos(degreesLatitude * (Math.PI / 180)) *
                            Math.sin(dLng / 2) * Math.sin(dLng / 2);
                        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                        const distanceToChurch = R * c;

                        // Se estiver a menos de 5km de distância (Cobrir toda a cidade) ou na igreja, contar presença!
                        if (distanceToChurch <= 5) {
                            let phone = remoteJid.replace(/\D/g, '');
                            const { data: member } = await supabase
                                .from('members_mondubim')
                                .select('id, name')
                                .or(`phone.eq.${phone},phone.eq.${phone.replace(/^55/, '')},phone.eq.55${phone}`)
                                .maybeSingle();

                            await supabase.from('attendance_mondubim').insert([{
                                phone,
                                member_name: member?.name || 'Anônimo',
                                checked_in_at: brTime.toISOString(),
                                day_of_week: 0
                            }]);

                            await this.sendMessage(remoteJid, "✅ *Presença Confirmada Automaticamente!* 📍\n\nIdentifiquei que você já está na região da Paz Church Mondubim!\n\nQue as bênçãos do Senhor sejam derramadas sobre você hoje! 🙏🔥");

                            return; // Encerra o fluxo aqui para não buscar célula, pois é hora do culto
                        }
                    }
                    // --- FIM CHECK-IN ---

                    // Buscar Lives no Supabase
                    // Correção: Nome da tabela ajustado de 'lifes' para 'lives' conforme erro PGRST205
                    const { data: lives, error } = await supabase.from('lives_mondubim').select('*');

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

    async sendGeneratedImageMessage(to: string, promptImg: string, caption?: string) {
        if (!this.sock) {
            console.warn('⚠️ WhatsApp não conectado ao tentar enviar imagem.');
            return;
        }

        const delay = Math.floor(Math.random() * 3000) + 2000;
        await new Promise(resolve => setTimeout(resolve, delay));

        if (!to) return;

        let jid = to;
        if (!jid.includes('@')) {
            if (jid.length >= 14) {
                jid = `${jid}@lid`;
            } else {
                jid = `${jid}@s.whatsapp.net`;
            }
        }

        try {
            const bodyOptions = JSON.stringify({ inputs: promptImg });
            const response = await fetch('https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.HF_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: bodyOptions
            });

            if (!response.ok) {
                throw new Error(`Servidor de imagem retornou erro: ${response.status} ${response.statusText}`);
            }

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.startsWith('image/')) {
                throw new Error(`Esperado imagem, mas recebeu ${contentType}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            await this.sock.sendMessage(jid, {
                image: buffer,
                caption: caption || ''
            });
            console.log(`✅ Imagem enviada para ${jid}`);
        } catch (error) {
            console.error(`❌ Erro ao baixar ou enviar imagem para ${jid}:`, error);
        }
    }


    /**
     * Envia uma mensagem de áudio/voz (nota de voz PTT) pelo WhatsApp.
     * @param to - JID do destinatário
     * @param audioPath - Caminho do arquivo de áudio (.ogg ou .mp3)
     */
    async sendAudioMessage(to: string, audioPath: string) {
        if (!this.sock || !to) return;

        let jid = to;
        if (!jid.includes('@')) {
            jid = jid.length >= 14 ? `${jid}@lid` : `${jid}@s.whatsapp.net`;
        }

        try {
            const audioBuffer = fs.readFileSync(audioPath);
            const isOgg = audioPath.endsWith('.ogg');

            console.log(`📤 Enviando áudio de voz para: ${jid}`);

            await this.sock.sendMessage(jid, {
                audio: audioBuffer,
                mimetype: isOgg ? 'audio/ogg; codecs=opus' : 'audio/mpeg',
                ptt: true, // PTT = Push To Talk = nota de voz (bolinha de áudio)
            });
            console.log(`✅ Áudio enviado para ${jid}`);
        } catch (error) {
            console.error(`❌ Erro ao enviar áudio para ${jid}:`, error);
            // Fallback: tenta enviar como mensagem de texto informando o erro
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
