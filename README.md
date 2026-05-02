# Graft

Shared resource coordination layer for parallel AI coding agents.

## Installation

### TypeScript/Node.js
```bash
npm install
npm run build
```

### Python
```bash
pip install .
```

## Usage

Start the Graft bus:
```bash
graft start
```

## Architecture

Graft provides OS-level concurrency primitives (mutexes, event buses, semaphores, barriers) to the agent layer. Agents claim shared resources before touching them, broadcast signals mid-execution, and respond to incoming signals based on user-configured strategies.

For more details, see [CLAUDE.md](CLAUDE.md).