# System Architecture

## Main Flow

Developer
    ↓
Frontend
    ↓
API
    ↓
Control Plane
    ↓
Scheduler
    ↓
Node Agent
    ↓
Docker
    ↓
Application
    ↓
Actual State
    ↓
Reconciliation
    ↺

## Components

### Web
The frontend where developers interact with the platform.

### API
Receives requests from the frontend and communicates with backend systems.

### Control Plane
The brain of the platform. It manages desired state, actual state,
scheduling, and reconciliation.

### Scheduler
Decides which node should run a workload.

### Node Agent
Runs on an infrastructure node and executes workload operations.

### Docker
Runs applications as containers.

### Reconciliation
Compares desired state with actual state and fixes differences.