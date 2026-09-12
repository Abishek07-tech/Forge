# Control Platform

A developer and infrastructure control platform that deploys,
monitors, and manages applications.

The platform uses desired state, actual state, drift detection,
and reconciliation to keep infrastructure in the state requested
by the developer.

## Core Idea

Developer
    ↓
Platform
    ↓
Deploy
    ↓
Monitor
    ↓
Detect Drift
    ↓
Reconcile
    ↓
Verify

## Main Components

- Web
- API
- Control Plane
- Scheduler
- Node Agent
- Docker
- PostgreSQL
- Redis
- Observability

## Project Goal

Build a complete full-stack and infrastructure platform
that can deploy and manage applications across infrastructure
nodes.