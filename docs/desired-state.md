# Desired State

## Example

Developer wants:

Application: My API
Replicas: 3
CPU: 2
Memory: 4GB

## Desired State

Replicas = 3

## Actual State

Replicas = 2

## Drift

Desired = 3
Actual = 2

There is a drift because the desired state and actual state
are different.

## Reconciliation

The platform detects the drift.

It creates the missing workload.

Then it checks the health of the workload.

Final state:

Desired = 3
Actual = 3