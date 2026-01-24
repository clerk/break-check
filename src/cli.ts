#!/usr/bin/env node

const args = process.argv.slice(2);

function main() {
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(`
snapi - Snapi CLI

Usage:
  snapi <command> [options]

Commands:
  help    Show this help message
  version Show version

Options:
  -h, --help     Show help
  -v, --version  Show version
`);
    return;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    console.log("0.0.1");
    return;
  }

  console.log(`Unknown command: ${command}`);
  process.exit(1);
}

main();
