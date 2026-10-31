# OP TRACK FLEX PREMIUM

Sistema independente para cadastro e acompanhamento de ordens de produção. A equipe cria a OP, avança pelas quatro etapas e o cliente consulta o andamento usando o número da OP e um código individual. O dashboard inclui prazos e movimentações persistidas, além de temas claro e preto.

## Requisitos

- Node.js 22.12 ou superior
- pnpm 11 ou superior

## Repositório e publicação

O projeto inclui `.gitignore`, `.gitattributes`, `.vercelignore` e `.env.example` para separar código de dados e credenciais locais. Use o guia [Repositório e publicação](docs/PUBLICACAO_E_REPOSITORIO.md) para enviar o código a um repositório Git. A versão atual ainda não pode ser publicada como sistema funcional na Vercel: o servidor e o SQLite precisam ser adaptados para funções e banco persistente antes de criar a configuração de deploy.

## Iniciar em desenvolvimento

```powershell
pnpm install
pnpm dev
```

Abra `http://127.0.0.1:5173`. Na primeira visita, crie a Conta Proprietária. Ela é individual, tem acesso total e administra as contas da equipe. O serviço local da API usa `http://127.0.0.1:4179` e grava os dados em `data/optrack.sqlite`. O acesso inicial local está limitado ao endereço de loopback.

## Produção

```powershell
pnpm build
pnpm start
```

Configure `NODE_ENV=production`, `HOST`, `PORT`, `OPTRACK_DATA_DIR`, `APP_ORIGIN`, `OPTRACK_SETUP_TOKEN`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `RESEND_API_KEY`, `OPTRACK_EMAIL_FROM`, `OPTRACK_OP_PREFIX` e `OPTRACK_SEQUENCE_WIDTH` no ambiente de execução. Use a origem HTTPS exata e sem barra final em `APP_ORIGIN`. Crie um widget Turnstile permitido para o domínio publicado. A site key é pública; a secret key fica somente no servidor. O servidor valida cada token com a API Siteverify e falha de forma segura quando a verificação não funciona. Para testar o widget em desenvolvimento, configure o par de chaves de teste oficial; nunca o use em produção. Sem chaves no ambiente local, os formulários usam limites de tentativas e o cadastro mantém aprovação obrigatória. Configure `RESEND_API_KEY` e `OPTRACK_EMAIL_FROM` no servidor; o remetente precisa pertencer a um domínio verificado no Resend. A chave não deve ter prefixo `VITE_` nem chegar ao navegador. Em produção, o servidor não inicia sem essas configurações. Antes de iniciar, gere um segredo de ativação para a primeira Conta Proprietária e injete-o pelo gerenciador de segredos do ambiente — nunca o grave no código ou no bundle do navegador:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Configure o resultado em `OPTRACK_SETUP_TOKEN` (mínimo de 32 bytes). A tela de primeiro acesso solicita esse segredo uma única vez; depois que a Conta Proprietária é criada, o endpoint de configuração retorna conflito e não cria outra. Configure a origem pública exata para validar todas as requisições de escrita. O servidor aplica CSP, HSTS em produção, proteção contra enquadramento, MIME sniffing, política de referência e permissões do navegador. Publique somente atrás de HTTPS e faça backup regular do diretório de dados.

Para anexos em produção, configure `OPTRACK_STORAGE_DRIVER=supabase`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` e `OPTRACK_STORAGE_BUCKET` no ambiente do servidor. Crie no Supabase um bucket **privado**, com limite de 6 MB e tipos permitidos `application/pdf`, `image/png`, `image/jpeg` e `image/webp`. A chave secreta fica somente no servidor; nunca use prefixo `VITE_` nem a inclua no navegador. A equipe acessa os anexos por rotas autenticadas; o portal do cliente recebe apenas comprovantes marcados explicitamente como compartilháveis e exige novamente o número da OP e o código individual.

Os limites de requisição são mantidos em memória por processo. Uma publicação com múltiplas instâncias ou atrás de proxy deve complementar os limites de abuso com controles equivalentes no proxy/gateway, usando a cadeia de IPs confiável da implantação.

## Comportamento

- A configuração inicial só aceita a criação da primeira Conta Proprietária. Em produção, exige a chave de ativação única configurada em `OPTRACK_SETUP_TOKEN`. A tela de configuração cria a conta com o nome, e-mail e senha escolhidos pelo proprietário; não existe senha universal embutida no código.
- Endereços de e-mail precisam ser confirmados com um código de uso único enviado por e-mail. A confirmação prova que a pessoa consegue receber mensagens naquele endereço; ela ocorre antes da aprovação da Conta Proprietária e de qualquer acesso. O código expira em 15 minutos, tem limite de tentativas e reenvio com intervalo. Em desenvolvimento sem serviço de e-mail, o código aparece na interface com indicação explícita de que é somente local.
- Perfis disponíveis: Proprietário, Administrador, Operador e Consulta. A Conta Proprietária tem acesso total e é a única que aprova solicitações, concede perfis, cria administradores e desativa contas. Administradores e Operadores atualizam OPs; Consulta só visualiza. O servidor verifica as permissões em cada escrita.
- Cadastros feitos pela tela pública ficam pendentes e começam sem acesso. A Conta Proprietária aprova e escolhe o perfil antes do primeiro login. A migração local promove o administrador ativo mais antigo a Proprietário para preservar o acesso existente.
- A Conta Proprietária pode remover acessos. Contas sem vínculos com OPs, eventos ou arquivos são apagadas; contas com histórico são desativadas, arquivadas na aba Removidas e podem ser restauradas.
- Cada usuário autenticado pode trocar a própria senha confirmando a senha atual; a troca encerra as demais sessões e grava somente um hash com salt.
- Login, cadastro público, configuração inicial e consulta do cliente usam Cloudflare Turnstile com validação obrigatória no servidor em produção, além de limites por IP e campo honeypot no cadastro.
- O envio dos códigos de confirmação usa a API do Resend, configurada somente no servidor por `RESEND_API_KEY` e `OPTRACK_EMAIL_FROM`. A empresa deve verificar o domínio de envio no Resend e informar isso no aviso de privacidade antes da publicação. Consulte a [API de envio de e-mails](https://resend.com/docs/api-reference/emails/send-email) e a [política de privacidade do Resend](https://resend.com/legal/privacy-policy).
- As preferências de cookies identificam o cookie de sessão necessário e permitem optar por lembrar o tema. O aviso de privacidade na interface é um modelo e precisa receber razão social/CNPJ, contato de privacidade, base legal e prazos de retenção definidos pela empresa antes da publicação.
- Senhas e códigos de rastreamento são armazenados como hashes com salt.
- O código de rastreamento é mostrado uma vez no cadastro ou na regeneração; gere outro código se ele for perdido.
- As etapas avançam em sequência: Pedido criado → Em produção → Saiu para entrega → Entregue ao destino.
- Observações internas e dados de contato não são devolvidos ao portal público.
- A área da OP registra responsável, pendência e próxima ação, decisão de aprovação da arte e autoria das atualizações.
- Entrega e logística guardam modalidade, transportadora, dados internos do motorista, previsão, rastreio, saída, recebimento e ocorrências sem apagar eventos anteriores.
- Artes, aprovações e comprovantes são identificados e armazenados em área privada; o cliente só acessa comprovante quando a equipe habilita o compartilhamento.
- Anexos aceitos: PDF, PNG, JPG e WEBP, até 6 MB por arquivo. O servidor confere o conteúdo do arquivo antes de armazená-lo.
- O dashboard consulta registros persistidos, alerta para prazos vencidos/próximos e mostra zero/estado vazio antes das primeiras OPs.
- Uma OP inclui cliente/contato, empresa, produto, quantidade, previsão de entrega, destino e notas internas.
- Os formulários e endpoints validam formatos e limites; corpos JSON têm limite de 64 KiB e há limites por IP para setup, login, consulta de rastreio e escrita autenticada.
- O tema preto preserva as cores e o significado visual das quatro etapas. A preferência fica no navegador do usuário.

## Dados e evolução

Esta primeira versão local usa SQLite embutido no Node para permitir execução sem instalar um servidor de banco de dados. O modo Supabase descrito acima configura o armazenamento privado dos anexos; os registros de OP, usuários, sessões e eventos continuam no SQLite. Antes de uma implantação compartilhada em Vercel ou outra plataforma sem disco persistente, a camada de banco deve ser migrada para PostgreSQL/Supabase, com migrations versionadas, política de backup, rate limiting compartilhado e gestão de segredos do ambiente. A integração com o sistema principal e qualquer sincronização de dados continuam fora do escopo desta versão; essa análise dependerá do esquema de OP, do fluxo de geração de números, dos estados válidos, do modelo de usuários e das interfaces disponíveis no sistema principal.

O Turnstile valida os tokens no endpoint oficial Siteverify do Cloudflare; tokens vencem em cinco minutos e são de uso único, por isso cada formulário pede uma nova verificação após o envio. Consulte a [documentação de integração](https://developers.cloudflare.com/turnstile/get-started/) e cadastre apenas os domínios que serão usados.
