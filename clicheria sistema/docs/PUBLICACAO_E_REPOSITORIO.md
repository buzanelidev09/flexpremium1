# Repositório e publicação

## Arquivos preparados

- `.gitignore` exclui dependências, builds, banco local, anexos e arquivos de ambiente.
- `.vercelignore` impede o envio de dados locais e segredos no contexto de build da Vercel.
- `.env.example` contém nomes de configuração e valores somente locais; não contém credenciais.
- `.gitattributes` padroniza finais de linha para facilitar o trabalho em Windows, macOS e Linux.
- `pnpm-lock.yaml` deve acompanhar o `package.json` no repositório para instalações reproduzíveis.

Para iniciar localmente, copie o modelo e instale as dependências:

```powershell
Copy-Item .env.example .env.local
pnpm install --frozen-lockfile
pnpm dev
```

O arquivo `.env.local` é ignorado pelo Git. Não publique senhas, tokens, chaves privadas, `data/` nem o banco SQLite.

## Enviar para GitHub, GitLab ou outro repositório Git

Crie um repositório vazio no serviço escolhido e execute os comandos na pasta do projeto, substituindo o endereço pelo endereço do seu repositório:

```powershell
git init
git add .
git status
git commit -m "Preparar OP TRACK"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/op-track.git
git push -u origin main
```

Troque a URL de exemplo pelo endereço real do repositório antes de executar o comando. Confira `git status` antes do commit. Os arquivos locais `.env.local`, `data/`, `dist/` e `node_modules/` não devem aparecer entre os arquivos preparados para envio.

## Situação da Vercel

O frontend usa Vite e pode ser compilado com `pnpm build`. O backend ainda não está pronto para uma publicação funcional na Vercel, então este repositório não inclui um `vercel.json` que poderia publicar somente a interface e deixar cadastro, login, rastreio e gestão sem API.

Há duas mudanças necessárias antes do deploy:

1. Transformar as rotas atuais do servidor próprio em Vercel Functions. Hoje `server/index.mjs` cria um servidor HTTP persistente e chama `listen()`; a Vercel executa arquivos de função dentro de `api/`.
2. Migrar usuários, sessões, OPs, eventos, códigos de confirmação e limites compartilhados do SQLite local para uma base persistente, como Supabase Postgres. O SQLite atual grava em `data/optrack.sqlite`, que não é um banco compartilhado nem armazenamento durável entre instâncias serverless. Supabase Storage já está previsto para anexos, mas não guarda os dados centrais do sistema.

A Vercel documenta funções como pontos de entrada em `api/` e recomenda armazenamento externo para dados que precisam persistir. Consulte [Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js), [configuração de projeto](https://vercel.com/docs/project-configuration/vercel-json) e [armazenamento de arquivos](https://vercel.com/kb/guide/how-can-i-use-files-in-serverless-functions). Até a migração do backend e do banco, conecte o repositório a uma hospedagem que aceite o servidor Node atual e tenha disco persistente, ou aguarde a preparação da versão Vercel.

Depois dessa migração, as variáveis de produção devem ser cadastradas diretamente no painel da Vercel, nunca no Git: origem pública, segredo de ativação inicial, Turnstile, Resend e Supabase. Os nomes atualmente usados no servidor estão descritos em `README.md`; a conexão Postgres ainda precisa ser definida na implementação Vercel.
