#!/usr/bin/env node
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { platform } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 确定二进制文件路径
const binaryName = platform() === 'win32' 
  ? 'autoui-mcp.exe' 
  : 'autoui-mcp';

const binaryPath = join(__dirname, '..', 'target', 'release', binaryName);

// 启动二进制文件，透传所有参数和环境变量
const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env
});

child.on('exit', (code) => {
  process.exit(code || 0);
});

process.on('SIGINT', () => {
  child.kill('SIGINT');
});

process.on('SIGTERM', () => {
  child.kill('SIGTERM');
});
