import type { DesiredState } from "../../types/desired-state.ts";
import type { ActualStateObservation } from "../../types/actual-state.ts";
import type {
  DriftCategory,
  DriftComparisonOutcome,
  DriftComparisonResult,
  DriftFinding,
  DriftProperty,
} from "../../types/drift.ts";

export class DriftComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriftComparisonError";
  }
}

function quote(value: string | number): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function formatEnvironmentExplanation(
  driftedKeys: string[],
  unobservedKeys: string[]
): string {
  const parts: string[] = [];
  if (driftedKeys.length > 0) {
    parts.push(`differ: ${driftedKeys.join(", ")}`);
  }
  if (unobservedKeys.length > 0) {
    parts.push(`not observed: ${unobservedKeys.join(", ")}`);
  }
  return `Declared environment key(s) ${parts.join("; ")} (values omitted).`;
}

function scalarFinding(
  property: DriftProperty,
  category: DriftCategory,
  desiredValue: string | number,
  observedValue: string | number,
  explanation: string
): DriftFinding {
  return {
    property,
    category,
    explanation,
    desiredValue,
    observedValue,
  };
}

export function compareDesiredAndActual(
  desired: DesiredState,
  actual: ActualStateObservation
): DriftComparisonResult {
  if (desired.projectId !== actual.projectId) {
    throw new DriftComparisonError(
      `Cannot compare Desired State for project "${desired.projectId}" with an observation for project "${actual.projectId}".`
    );
  }

  const findings: DriftFinding[] = [];
  const unknownProperties: DriftProperty[] = [];
  const comparedProperties: DriftProperty[] = [];

  const observedImage = actual.application.image;
  if (observedImage === null) {
    unknownProperties.push("application.image");
  } else {
    comparedProperties.push("application.image");
    if (observedImage !== desired.applications.image) {
      findings.push(
        scalarFinding(
          "application.image",
          "changed",
          desired.applications.image,
          observedImage,
          `Declared image ${quote(desired.applications.image)} but observed ${quote(observedImage)}.`
        )
      );
    }
  }

  const observedPort = actual.application.port;
  if (observedPort === null) {
    unknownProperties.push("application.port");
  } else {
    comparedProperties.push("application.port");
    if (observedPort !== desired.applications.port) {
      findings.push(
        scalarFinding(
          "application.port",
          "configuration-mismatch",
          desired.applications.port,
          observedPort,
          `Declared port ${desired.applications.port} but observed ${observedPort}.`
        )
      );
    }
  }

  const declaredAppVersion = desired.applications.version;
  if (declaredAppVersion !== undefined) {
    const observedAppVersion = actual.application.version;
    if (observedAppVersion === undefined) {
      unknownProperties.push("application.version");
    } else {
      comparedProperties.push("application.version");
      if (observedAppVersion !== declaredAppVersion) {
        findings.push(
          scalarFinding(
            "application.version",
            "version-mismatch",
            declaredAppVersion,
            observedAppVersion,
            `Declared application version ${quote(declaredAppVersion)} but observed ${quote(observedAppVersion)}.`
          )
        );
      }
    }
  }

  const declaredReplicas = desired.runtime.replicas;
  const observedReplicas = actual.runtime.replicas;
  if (observedReplicas === null) {
    unknownProperties.push("runtime.replicas");
  } else {
    comparedProperties.push("runtime.replicas");
    if (observedReplicas < declaredReplicas) {
      findings.push(
        scalarFinding(
          "runtime.replicas",
          "missing",
          declaredReplicas,
          observedReplicas,
          `Declared ${declaredReplicas} replica(s) but only ${observedReplicas} observed.`
        )
      );
    } else if (observedReplicas > declaredReplicas) {
      findings.push(
        scalarFinding(
          "runtime.replicas",
          "extra",
          declaredReplicas,
          observedReplicas,
          `Observed ${observedReplicas} replica(s) but only ${declaredReplicas} declared; ${observedReplicas - declaredReplicas} replica(s) not declared.`
        )
      );
    }
  }

  const observedCpu = actual.resources.cpu;
  if (observedCpu === null) {
    unknownProperties.push("resources.cpu");
  } else {
    comparedProperties.push("resources.cpu");
    if (observedCpu !== desired.resources.cpu) {
      findings.push(
        scalarFinding(
          "resources.cpu",
          "configuration-mismatch",
          desired.resources.cpu,
          observedCpu,
          `Declared cpu ${quote(desired.resources.cpu)} but observed ${quote(observedCpu)}.`
        )
      );
    }
  }

  const observedMemory = actual.resources.memory;
  if (observedMemory === null) {
    unknownProperties.push("resources.memory");
  } else {
    comparedProperties.push("resources.memory");
    if (observedMemory !== desired.resources.memory) {
      findings.push(
        scalarFinding(
          "resources.memory",
          "configuration-mismatch",
          desired.resources.memory,
          observedMemory,
          `Declared memory ${quote(desired.resources.memory)} but observed ${quote(observedMemory)}.`
        )
      );
    }
  }

  const declaredEnvironment = desired.environment;
  if (declaredEnvironment !== undefined) {
    const observedEnvironment = actual.environment;
    if (observedEnvironment === undefined) {
      unknownProperties.push("environment");
    } else {
      const declaredKeys = Object.keys(declaredEnvironment).sort();
      const driftedKeys: string[] = [];
      const unobservedKeys: string[] = [];
      for (const key of declaredKeys) {
        if (!Object.hasOwn(observedEnvironment, key)) {
          unobservedKeys.push(key);
        } else if (observedEnvironment[key] !== declaredEnvironment[key]) {
          driftedKeys.push(key);
        }
      }
      if (driftedKeys.length === 0 && unobservedKeys.length > 0) {
        unknownProperties.push("environment");
      } else {
        comparedProperties.push("environment");
        if (driftedKeys.length > 0) {
          findings.push({
            property: "environment",
            category: "configuration-mismatch",
            explanation: formatEnvironmentExplanation(
              driftedKeys,
              unobservedKeys
            ),
          });
        }
      }
    }
  }

  const declaredDeployment = desired.deployment;
  if (declaredDeployment !== undefined) {
    const observedDeployment = actual.deployment;
    if (
      observedDeployment === undefined ||
      observedDeployment.version === null
    ) {
      unknownProperties.push("deployment.version");
    } else {
      comparedProperties.push("deployment.version");
      if (observedDeployment.version !== declaredDeployment.version) {
        findings.push(
          scalarFinding(
            "deployment.version",
            "version-mismatch",
            declaredDeployment.version,
            observedDeployment.version,
            `Declared deployment version ${declaredDeployment.version} but observed version ${observedDeployment.version}.`
          )
        );
      }
    }
  }

  const observedHealthStatus = actual.health.status;
  if (observedHealthStatus === "unknown") {
    unknownProperties.push("health.status");
  } else {
    comparedProperties.push("health.status");
    if (observedHealthStatus === "unhealthy") {
      findings.push(
        scalarFinding(
          "health.status",
          "unhealthy",
          "healthy",
          "unhealthy",
          `Observed health status is "unhealthy"; the declaration requires a passing health check at ${quote(desired.health.path)}.`
        )
      );
    }
  }

  const outcome: DriftComparisonOutcome =
    findings.length > 0
      ? "drift"
      : comparedProperties.length > 0
        ? "match"
        : "insufficient-data";

  return {
    projectId: desired.projectId,
    workloadId: actual.workloadId,
    outcome,
    findings,
    unknownProperties,
    comparedProperties,
  };
}
