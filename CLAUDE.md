# TeamClaw

## FC (Function Compute) Deployment

FC function `teamclaw-sync` is deployed to Alibaba Cloud cn-shenzhen region.

Deploy command:

```bash
cd fc && bash deploy.sh
```

Prerequisites:
- Serverless Devs CLI (`s`) installed (`npm install -g @serverless-devs/s`)
- `s config` configured with AccessKeyID/AccessKeySecret/AccountID
- `.env.local` in repo root with `SLS_ACCESS_KEY_ID`, `SLS_ACCESS_KEY_SECRET`, `ROLE_ARN`

The deploy script reads `.env.local`, maps env vars, installs deps, and runs `s deploy`.

Production endpoint: `https://cloud.ucar.cc`
