#!/usr/bin/env node
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
const binaryPath = join(projectRoot, 'target', 'release', 'autoui-mcp');

// 如果二进制文件不存在，尝试构建
if (!existsSync(binaryPath)) {
  console.log('🔨 Building autoui-mcp...');
  try {
    execSync('cargo build --release', {
      cwd: projectRoot,
      stdio: 'inherit'
    });
    console.log('✅ Build complete!');
  } catch (error) {
    console.error('❌ Build failed. Please ensure Rust is installed.');
    console.error('   Visit https://rustup.rs to install Rust');
    process.exit(1);
  }
} else {
  console.log('✅ autoui-mcp binary found');
}
