# MemoriaHub Specialized Agents

This directory contains configurations for specialized Claude Code subagents that can be used to delegate specific tasks.

## Agent Overview

| Agent | File | Purpose | When to Use |
|-------|------|---------|-------------|
| **Testing** | [TESTING_AGENT.md](./TESTING_AGENT.md) | Test creation, coverage, edge cases | After writing new features |
| **Backend** | [BACKEND_AGENT.md](./BACKEND_AGENT.md) | API, services, repositories | New endpoints, business logic |
| **Frontend** | [FRONTEND_AGENT.md](./FRONTEND_AGENT.md) | React, MUI, components | UI features, pages |
| **Security** | [SECURITY_AGENT.md](./SECURITY_AGENT.md) | Vulnerability review, auth | After any code changes |
| **Database** | [DATABASE_AGENT.md](./DATABASE_AGENT.md) | Migrations, queries, performance | Schema changes, optimization |
| **Documentation** | [DOCUMENTATION_AGENT.md](./DOCUMENTATION_AGENT.md) | Technical docs, user guides | After feature completion |

## Recommended Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│                     Feature Implementation                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   1. PLANNING                                                    │
│      └── Human defines requirements                              │
│                                                                  │
│   2. IMPLEMENTATION (Parallel)                                   │
│      ├── Backend Agent → API endpoints, services                 │
│      └── Frontend Agent → UI components, pages                   │
│                                                                  │
│   3. VALIDATION (Sequential)                                     │
│      ├── Testing Agent → Create/verify tests                     │
│      ├── Security Agent → Review for vulnerabilities             │
│      └── Documentation Agent → Update docs                       │
│                                                                  │
│   4. VERIFICATION                                                │
│      └── Human reviews and approves                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## How to Use These Agents

### In Claude Code CLI

When using Claude Code, you can reference these agent configurations in your prompts:

```
Read docs/agents/TESTING_AGENT.md and follow its instructions to create tests for the new AlbumService
```

### With Task Tool (Subagents)

When Claude spawns a subagent using the Task tool, you can instruct it to follow a specific agent's guidelines:

```
Launch a testing agent following the patterns in docs/agents/TESTING_AGENT.md to create comprehensive tests for apps/api/src/services/albums/album.service.ts
```

## Quick Reference

### Testing Agent Prompts

```
# Create tests for a new file
Create comprehensive tests for [file path] following docs/agents/TESTING_AGENT.md

# Analyze coverage
Analyze test coverage gaps in [directory] and create tests for uncovered scenarios

# Fix failing tests
Fix the failing tests in [file] - the implementation changed to [describe change]
```

### When Each Agent is Most Valuable

| Scenario | Primary Agent | Supporting Agents |
|----------|---------------|-------------------|
| New API endpoint | Backend | Testing, Security, Docs |
| New UI page | Frontend | Testing, Docs |
| Bug fix | Backend/Frontend | Testing |
| Security audit | Security | - |
| Performance issue | Database | Backend |
| Schema change | Database | Backend, Docs |
| Documentation sprint | Documentation | - |

## Agent Communication

Agents don't directly communicate with each other. Instead:

1. Each agent completes its task and outputs results
2. Human reviews and approves
3. Next agent receives context from previous work

This ensures human oversight at each step while still leveraging specialized expertise.

## Creating New Agents

To create a new specialized agent:

1. Create `docs/agents/[NAME]_AGENT.md`
2. Define:
   - Agent identity and focus area
   - Specific files/directories in scope
   - Patterns and conventions to follow
   - Example prompts
   - Checklist for completion
3. Add to this README

## Principles

1. **Focused Scope**: Each agent has a clear, bounded responsibility
2. **Pattern Adherence**: Agents follow existing codebase conventions
3. **Human Oversight**: Agents produce work for human review
4. **Quality Gates**: Each agent has a completion checklist
5. **Documentation**: Agents document their reasoning and decisions
