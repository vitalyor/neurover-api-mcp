# Neurover MCP

Неофициальный локальный MCP-сервер для [neurover.io](https://neurover.io): медиатека, галерея очистки дублей, полотна (workflows) и генерации. Работает на вашем компьютере от имени вашего аккаунта Neurover; сторонний сервер не нужен.

Проект не связан с Neurover и не поддерживается ими.

## Установка

Нужен Node.js 22.16+.

```sh
git clone https://github.com/vitalyor/neurover-api-mcp.git
cd neurover-api-mcp
sh install.sh        # macOS/Linux; на Windows — install.cmd
```

Полная инструкция, режимы входа и подключение к MCP-клиенту: [docs/INSTALL.md](docs/INSTALL.md).
Что хранится локально и куда уходят данные: [docs/PRIVACY.md](docs/PRIVACY.md).

## Разработка

```sh
npm test
```

Карта модулей: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Наблюдаемые контракты API Neurover: [docs/API-CONTRACTS.md](docs/API-CONTRACTS.md).

## Лицензия

MIT, см. [LICENSE](LICENSE).
