/** 由 scripts/generate-contracts.mjs 从固定 Schema 生成，勿手改。Schema SHA-256: 96b3f5a17c6aa37f3d602064484a01468d9a5b61edeb0f733b5bd9a159e5180f。类型不替代运行时约束、授权或原生验收。 */

export type Dependency = {
  taskId: string;
  requiredTaskRevision: number;
  condition: "accepted" | "artifact_available";
  outputName?: string;
};
export type ProjectOrchCommandSchemaJson =
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "task.claim";
      payload: {
        taskId: string;
        expectedRevision: number;
        expectedSpecRevision: number;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "task.report";
      payload: {
        taskId: string;
        attemptId: string;
        bindingEpoch: number;
        report: string;
        wait: Wait | null;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "task.accept";
      payload: {
        taskId: string;
        taskRevision: number;
        resultId: string;
        decision: "accept" | "reject" | "needs_evidence";
        reason: string;
        /**
         * @minItems 0
         * @maxItems 128
         */
        evidenceArtifactIds: string[];
        ruleId: string;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "role.bind";
      payload: {
        roleId: string;
        expectedRevision: number;
        sessionRef: {
          harnessId: string;
          hostId: string;
          profileId: string;
          nativeConversationId: string;
          nativeWorkspaceId?: string;
        };
        handoverId: string | null;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "issue.raise";
      payload: {
        taskId: string | null;
        category: "transport" | "dependency" | "capacity" | "technical" | "scope" | "identity" | "unknown";
        summary: string;
        /**
         * @minItems 0
         * @maxItems 128
         */
        evidenceArtifactIds: string[];
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "message.ack";
      payload: {
        messageId: string;
        state: "acknowledged" | "resolved";
        bindingEpoch: number;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "artifact.register";
      payload:
        | {
            taskId: string;
            kind: "file" | "report";
            path: string;
            sha256: string;
            byteSize: number;
            taskRevision: number;
          }
        | {
            taskId: string;
            kind: "git_commit";
            repositoryPath: string;
            commitId: string;
            taskRevision: number;
          };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "project.pause";
      payload: {
        reason: string;
        currentWorkPolicy: "finish" | "request_stop";
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "project.resume";
      payload: {
        expectedRevision: number;
        reason: string;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "role.bootstrap";
      payload: {
        localRef: string;
        name: string;
        charter: string;
        permissionProfileId: string;
        permissionProfileRevision: number;
        expectedPolicyRevision: number;
        sessionRef: {
          harnessId: string;
          hostId: string;
          profileId: string;
          nativeConversationId: string;
          nativeWorkspaceId?: string;
        };
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "policy.configure";
      payload: {
        expectedRevision: number;
        policy: Policy;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "check.register";
      payload: {
        definition: CheckDefinition;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "result.revalidate";
      payload: {
        taskId: string;
        expectedRevision: number;
        oldResultId: string;
        targetSpecRevision: number;
        reason: string;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "question.ask";
      payload: {
        taskId: string;
        taskRevision: number;
        attemptId: string;
        bindingEpoch: number;
        prompt: string;
        answerer:
          | {
              kind: "user";
            }
          | {
              kind: "role";
              roleId: string;
            };
        deadline: string;
        onTimeout: "raise_issue" | "cancel_attempt";
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "question.answer";
      payload: {
        questionId: string;
        expectedRevision: number;
        answer: string;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "condition.verify";
      payload: {
        conditionId: string;
        expectedRevision: number;
        decision: "satisfied" | "unsatisfied";
        /**
         * @minItems 1
         * @maxItems 128
         */
        evidence: [ArtifactRef, ...ArtifactRef[]];
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "issue.resolve";
      payload: {
        caseId: string;
        expectedRevision: number;
        decision: "resolved" | "escalated";
        reason: string;
        /**
         * @minItems 1
         * @maxItems 128
         */
        evidence: [ArtifactRef, ...ArtifactRef[]];
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "goal.resolve";
      payload: {
        holdId: string;
        expectedRevision: number;
        expectedPlanRevision: number;
        /**
         * @minItems 0
         * @maxItems 128
         */
        affectedTaskIds: string[];
        decision: "apply_revision" | "dismiss_untrusted" | "request_user";
        changesetId: string | null;
        reason: string;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "workspace.register";
      payload: {
        localRef: string;
        path: string;
        kind: "git" | "directory";
        /**
         * @minItems 0
         * @maxItems 128
         */
        writePaths: string[];
        managed: boolean;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "workspace.reserve";
      payload: {
        workspaceId: string;
        expectedRevision: number;
        taskId: string;
        taskRevision: number;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "workspace.release";
      payload: {
        workspaceId: string;
        expectedRevision: number;
        reason: string;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "handover.prepare";
      payload: {
        roleId: string;
        expectedBindingEpoch: number;
        artifact: ArtifactRef;
        /**
         * @minItems 0
         * @maxItems 128
         */
        taskSpecRevisions: {
          taskId: string;
          specRevision: number;
        }[];
        /**
         * @minItems 0
         * @maxItems 128
         */
        workspaceVersions: {
          workspaceId: string;
          contentHash: string;
        }[];
        /**
         * @minItems 0
         * @maxItems 128
         */
        unresolvedIssueIds: string[];
        /**
         * @minItems 0
         * @maxItems 128
         */
        pendingEffects: string[];
        verifierRoleId: string;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "handover.verify";
      payload: {
        handoverId: string;
        expectedRevision: number;
        decision: "verified" | "stale";
        /**
         * @minItems 1
         * @maxItems 128
         */
        evidence: [ArtifactRef, ...ArtifactRef[]];
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "integration.request";
      payload: {
        taskId: string;
        taskRevision: number;
        targetWorkspaceId: string;
        targetVersion: string;
        /**
         * @minItems 1
         * @maxItems 128
         */
        artifacts: [ArtifactRef, ...ArtifactRef[]];
        /**
         * @minItems 1
         * @maxItems 128
         */
        checkRefs: [
          {
            id: string;
            version: string;
          },
          ...{
            id: string;
            version: string;
          }[]
        ];
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "role.startup_ack";
      payload: {
        roleId: string;
        bindingEpoch: number;
        protocolVersion: 2;
        policyRevision: number;
        planRevision: number;
        /**
         * @minItems 0
         * @maxItems 128
         */
        taskSpecRevisions: {
          taskId: string;
          specRevision: number;
        }[];
        roleRevision: number;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "native.input";
      payload: {
        roleId: string;
        bindingEpoch: number;
        body: string;
        delivery: {
          mode: "inbox" | "when_available" | "steer_current" | "interrupt_then_deliver";
          priority: "normal" | "urgent";
          expectedExecutionId?: string;
          expectedBindingEpoch?: number;
          expiresAt?: string;
        };
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "native.stop";
      payload: {
        roleId: string;
        bindingEpoch: number;
        expectedExecutionId: string;
        reason: string;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "role.provision";
      payload: {
        roleId: string;
        expectedRevision: number;
        harnessId: "codex" | "zcode";
        /**
         * 显式新会话接替：消费当前已独立核验交接包；缺省仅允许未绑定子角色
         */
        handoverId?: string;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "integration.evaluate";
      payload: {
        integrationId: string;
        expectedRevision: number;
        resultId: string;
        targetKind: "files" | "git";
        /**
         * @minItems 1
         * @maxItems 16
         */
        checkParameters: [
          {
            checkId: string;
            checkVersion: string;
            parameters: {
              /**
               * @minItems 1
               * @maxItems 16
               */
              files: [
                {
                  path: string;
                  /**
                   * @minItems 1
                   * @maxItems 64
                   */
                  assertions: [
                    {
                      pointer: string;
                      equals: unknown;
                    },
                    ...{
                      pointer: string;
                      equals: unknown;
                    }[]
                  ];
                },
                ...{
                  path: string;
                  /**
                   * @minItems 1
                   * @maxItems 64
                   */
                  assertions: [
                    {
                      pointer: string;
                      equals: unknown;
                    },
                    ...{
                      pointer: string;
                      equals: unknown;
                    }[]
                  ];
                }[]
              ];
            };
          },
          ...{
            checkId: string;
            checkVersion: string;
            parameters: {
              /**
               * @minItems 1
               * @maxItems 16
               */
              files: [
                {
                  path: string;
                  /**
                   * @minItems 1
                   * @maxItems 64
                   */
                  assertions: [
                    {
                      pointer: string;
                      equals: unknown;
                    },
                    ...{
                      pointer: string;
                      equals: unknown;
                    }[]
                  ];
                },
                ...{
                  path: string;
                  /**
                   * @minItems 1
                   * @maxItems 64
                   */
                  assertions: [
                    {
                      pointer: string;
                      equals: unknown;
                    },
                    ...{
                      pointer: string;
                      equals: unknown;
                    }[]
                  ];
                }[]
              ];
            };
          }[]
        ];
        /**
         * 明确选择目标工作区内交付内容子目录；不传表示整个工作区，遇Harness运行元数据明确拒绝，不静默跳过。
         */
        contentPath?: string;
      };
    }
  | {
      schemaVersion: 2;
      requestId: string;
      projectId: string;
      type: "integration.review";
      payload: {
        integrationId: string;
        expectedRevision: number;
        targetId: string;
        /**
         * @minItems 1
         * @maxItems 16
         */
        runIds: [string, ...string[]];
        decision: "accept" | "reject";
        reason: string;
        /**
         * @minItems 1
         * @maxItems 128
         */
        evidence: [ArtifactRef, ...ArtifactRef[]];
        repairTaskId?: string;
      };
    };
export type ProjectOrchEventSchemaJson = {
  schemaVersion: 2;
  eventId: string;
  sequence: number;
  projectId: string;
  occurredAt: string;
  type:
    | "role.changed"
    | "binding.changed"
    | "task.changed"
    | "attempt.changed"
    | "message.changed"
    | "case.changed"
    | "changeset.changed"
    | "native.item.changed"
    | "native.status.changed"
    | "native.history.reset"
    | "approval.changed"
    | "capability.changed"
    | "question.changed"
    | "wait.changed"
    | "goal.hold.changed"
    | "workspace.changed"
    | "handover.changed"
    | "integration.changed"
    | "guard.denied"
    | "role.protocol.violation";
  entityId: string;
  entityRevision: number;
  causationId: string | null;
  source: Source;
  data: {
    [k: string]: unknown;
  };
};
export type ProjectOrchEvidenceSchemaJson = {
  schemaVersion: 2;
  evidenceId: string;
  caseId: string;
  status: "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
  kind: "unit" | "integration" | "native" | "e2e" | "security" | "load" | "release" | "manual";
  recordedAt: string;
  environment: {
    os: string;
    node: string;
    harnessVersions?: {
      [k: string]: {
        client: string;
        backend: string;
        adapter: string;
        protocol: string;
      };
    };
  };
  /**
   * @minItems 0
   * @maxItems 128
   */
  steps: string[];
  /**
   * @minItems 0
   * @maxItems 128
   */
  assertions: string[];
  /**
   * @minItems 0
   * @maxItems 128
   */
  files: {
    path: string;
    sha256: string;
    kind: "raw_log" | "native_event" | "dual_end_observation" | "artifact" | "review" | "timing" | "other";
  }[];
  /**
   * @minItems 0
   * @maxItems 32
   */
  nativeSessionRefs: {
    harnessId: string;
    hostId: string;
    profileId: string;
    nativeConversationId: string;
    nativeWorkspaceId?: string;
  }[];
  notes: string;
  subject: {
    applicationCommit: string | null;
    sourceTreeSha256: string;
    contractVersion: 2;
    targetPlatform: string;
    /**
     * @minItems 1
     * @maxItems 128
     */
    components: [
      {
        id: string;
        sha256: string;
      },
      ...{
        id: string;
        sha256: string;
      }[]
    ];
    /**
     * @minItems 0
     * @maxItems 128
     */
    releaseArtifactHashes: string[];
  } | null;
  executorId: string | null;
  review: {
    status: "PENDING" | "APPROVED" | "CHANGES_REQUESTED";
    reviewerId: string | null;
    report: {
      path: string;
      sha256: string;
    } | null;
    subjectSha256: string | null;
  };
  applicability: {
    candidateSourceTreeSha256: string;
    /**
     * @minItems 1
     * @maxItems 128
     */
    unchangedComponentIds: [string, ...string[]];
    impactReport: {
      path: string;
      sha256: string;
    };
    reviewerId: string;
  } | null;
};
export type HttpsProjectorchInvalidSchemasFeasibilitySchemaJson = {
  schemaVersion: 2;
  harnessId: "codex" | "zcode";
  status: "NOT_STARTED" | "INVESTIGATING" | "CONCLUDED";
  conclusion: "UNKNOWN" | "FEASIBLE" | "INFEASIBLE" | "INCONCLUSIVE";
  ownerId: string | null;
  investigationBudget: {
    maxRoutes: 3;
    maxHours: number;
  };
  /**
   * @minItems 0
   * @maxItems 3
   */
  routes: {
    kind: "supported_entry" | "supported_extension" | "maintained_bridge";
    status: "NOT_TRIED" | "SUPPORTED" | "FAILED" | "BLOCKED";
    /**
     * @minItems 0
     * @maxItems 128
     */
    evidenceFiles: {
      path: string;
      sha256: string;
    }[];
    reason: string;
    maintenanceCost: string;
  }[];
  /**
   * @minItems 6
   * @maxItems 128
   */
  dimensions: [
    {
      name:
        | "backend_entry"
        | "existing_session_tools"
        | "trusted_identity"
        | "dual_end_race"
        | "recovery"
        | "bridge_distribution";
      conclusion: "UNKNOWN" | "SUPPORTED" | "UNSUPPORTED" | "BLOCKED";
      /**
       * @minItems 0
       * @maxItems 128
       */
      evidenceFiles: {
        path: string;
        sha256: string;
      }[];
      reason: string;
    },
    {
      name:
        | "backend_entry"
        | "existing_session_tools"
        | "trusted_identity"
        | "dual_end_race"
        | "recovery"
        | "bridge_distribution";
      conclusion: "UNKNOWN" | "SUPPORTED" | "UNSUPPORTED" | "BLOCKED";
      /**
       * @minItems 0
       * @maxItems 128
       */
      evidenceFiles: {
        path: string;
        sha256: string;
      }[];
      reason: string;
    },
    {
      name:
        | "backend_entry"
        | "existing_session_tools"
        | "trusted_identity"
        | "dual_end_race"
        | "recovery"
        | "bridge_distribution";
      conclusion: "UNKNOWN" | "SUPPORTED" | "UNSUPPORTED" | "BLOCKED";
      /**
       * @minItems 0
       * @maxItems 128
       */
      evidenceFiles: {
        path: string;
        sha256: string;
      }[];
      reason: string;
    },
    {
      name:
        | "backend_entry"
        | "existing_session_tools"
        | "trusted_identity"
        | "dual_end_race"
        | "recovery"
        | "bridge_distribution";
      conclusion: "UNKNOWN" | "SUPPORTED" | "UNSUPPORTED" | "BLOCKED";
      /**
       * @minItems 0
       * @maxItems 128
       */
      evidenceFiles: {
        path: string;
        sha256: string;
      }[];
      reason: string;
    },
    {
      name:
        | "backend_entry"
        | "existing_session_tools"
        | "trusted_identity"
        | "dual_end_race"
        | "recovery"
        | "bridge_distribution";
      conclusion: "UNKNOWN" | "SUPPORTED" | "UNSUPPORTED" | "BLOCKED";
      /**
       * @minItems 0
       * @maxItems 128
       */
      evidenceFiles: {
        path: string;
        sha256: string;
      }[];
      reason: string;
    },
    {
      name:
        | "backend_entry"
        | "existing_session_tools"
        | "trusted_identity"
        | "dual_end_race"
        | "recovery"
        | "bridge_distribution";
      conclusion: "UNKNOWN" | "SUPPORTED" | "UNSUPPORTED" | "BLOCKED";
      /**
       * @minItems 0
       * @maxItems 128
       */
      evidenceFiles: {
        path: string;
        sha256: string;
      }[];
      reason: string;
    },
    ...{
      name:
        | "backend_entry"
        | "existing_session_tools"
        | "trusted_identity"
        | "dual_end_race"
        | "recovery"
        | "bridge_distribution";
      conclusion: "UNKNOWN" | "SUPPORTED" | "UNSUPPORTED" | "BLOCKED";
      /**
       * @minItems 0
       * @maxItems 128
       */
      evidenceFiles: {
        path: string;
        sha256: string;
      }[];
      reason: string;
    }[]
  ];
  decisionReport: {
    path: string;
    sha256: string;
  } | null;
  review: {
    reviewerId: string;
    decision: "APPROVED";
    report: {
      path: string;
      sha256: string;
    };
  } | null;
  nextAction: string;
};
export type ProjectOrchMessageSchemaJson = {
  schemaVersion: 2;
  requestId: string;
  projectId: string;
  toRoleId: string;
  kind: "information" | "question" | "answer" | "task_request" | "result_notice" | "correction" | "control_request";
  body: string;
  taskId?: string;
  replyToMessageId?: string;
  /**
   * @minItems 0
   * @maxItems 64
   */
  artifacts?: {
    artifactId: string;
    version: string;
  }[];
  delivery: {
    mode: "inbox" | "when_available" | "steer_current" | "interrupt_then_deliver";
    priority: "normal" | "urgent";
    expectedExecutionId?: string;
    expectedBindingEpoch?: number;
    expiresAt?: string;
  };
};
export type HttpsProjectorchInvalidSchemasQuerySchemaJson =
  | {
      schemaVersion: 2;
      type: "identity";
      payload: Record<string, never>;
    }
  | {
      schemaVersion: 2;
      type: "task.read";
      payload: {
        taskId: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "task.list";
      payload: {
        projectId: string;
        cursor?: string;
        limit?: number;
      };
    }
  | {
      schemaVersion: 2;
      type: "role.read";
      payload: {
        roleId: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "role.list";
      payload: {
        projectId: string;
        cursor?: string;
        limit?: number;
      };
    }
  | {
      schemaVersion: 2;
      type: "result.read";
      payload: {
        resultId: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "artifact.read";
      payload: {
        artifactId: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "artifact.content";
      payload: {
        artifactId: string;
        version: string;
        offset: number;
      };
    }
  | {
      schemaVersion: 2;
      type: "issue.read";
      payload: {
        caseId: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "issue.list";
      payload: {
        projectId: string;
        cursor?: string;
        limit?: number;
      };
    }
  | {
      schemaVersion: 2;
      type: "question.read";
      payload: {
        questionId: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "question.list";
      payload: {
        projectId: string;
        cursor?: string;
        limit?: number;
      };
    }
  | {
      schemaVersion: 2;
      type: "policy.read";
      payload: {
        projectId: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "check.read";
      payload: {
        checkId: string;
        version: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "workspace.read";
      payload: {
        workspaceId: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "workspace.list";
      payload: {
        projectId: string;
        cursor?: string;
        limit?: number;
      };
    }
  | {
      schemaVersion: 2;
      type: "handover.read";
      payload: {
        handoverId: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "integration.read";
      payload: {
        integrationId: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "goal.hold.read";
      payload: {
        holdId: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "project.overview";
      payload: {
        projectId: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "session.list";
      payload: {
        projectId: string;
        cursor?: string;
        limit?: number;
      };
    }
  | {
      schemaVersion: 2;
      type: "project.list";
      payload: Record<string, never>;
    }
  | {
      schemaVersion: 2;
      type: "project.snapshot";
      payload: {
        projectId: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "session.history";
      payload: {
        sessionId: string;
        cursor?: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "receipt.read";
      payload: {
        requestId: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "inbox.read";
      payload: {
        roleId: string;
        cursor?: string;
        limit?: number;
      };
    }
  | {
      schemaVersion: 2;
      type: "capability.list";
      payload: Record<string, never>;
    }
  | {
      schemaVersion: 2;
      type: "events.subscribe";
      payload: {
        projectId: string;
        "Last-Event-ID"?: string;
      };
    }
  | {
      schemaVersion: 2;
      type: "integration.run.read";
      payload: {
        integrationId: string;
        runId: string;
      };
    };
export type ProjectOrchResultSchemaJson = {
  schemaVersion: 2;
  requestId: string;
  projectId: string;
  taskId: string;
  taskRevision: number;
  attemptId: string;
  bindingEpoch: number;
  outcome: "succeeded" | "failed" | "inconclusive";
  summary: string;
  /**
   * @minItems 0
   * @maxItems 128
   */
  outputs: {
    artifactId: string;
    version: string;
    outputName: string;
  }[];
  /**
   * @minItems 0
   * @maxItems 128
   */
  checks: {
    name: string;
    outcome: "passed" | "failed" | "not_run";
    evidenceArtifactId: string;
  }[];
  /**
   * @minItems 0
   * @maxItems 128
   */
  remainingIssues: string[];
};
export type Receipt = {
  requestId: string;
  projectId: string | null;
  commandId: string;
  status: "stored" | "queued" | "applying" | "completed" | "uncertain" | "failed";
  receiptUrl: string;
  /**
   * @minItems 0
   * @maxItems 128
   */
  entityIds: {
    localRef: string;
    entityType:
      | "project"
      | "role"
      | "task"
      | "attempt"
      | "message"
      | "artifact"
      | "case"
      | "question"
      | "workspace"
      | "handover"
      | "integration"
      | "policy"
      | "check"
      | "hold"
      | "result"
      | "binding";
    id: string;
    revision: number;
    version: string | null;
  }[];
  error: Detail | null;
  lastEventSequence: number;
};

export interface ContractRegistry {
  approval: ProjectOrchApprovalSchemaJson;
  "artifact-chunk": ProjectOrch;
  capabilities: ProjectOrchCapabilitiesSchemaJson;
  changeset: ProjectOrchChangesetSchemaJson;
  command: ProjectOrchCommandSchemaJson;
  error: ProjectOrchErrorSchemaJson;
  event: ProjectOrchEventSchemaJson;
  evidence: ProjectOrchEvidenceSchemaJson;
  feasibility: HttpsProjectorchInvalidSchemasFeasibilitySchemaJson;
  message: ProjectOrchMessageSchemaJson;
  pairing: HttpsProjectorchInvalidSchemasPairingSchemaJson;
  "project-create": ProjectOrchProjectCreateSchemaJson;
  query: HttpsProjectorchInvalidSchemasQuerySchemaJson;
  result: ProjectOrchResultSchemaJson;
  "task-readiness": ProjectOrch1;
  receipt: Receipt;
  policy: Policy;
  "task-detail": TaskDetail;
  "task-spec": TaskSpec;
  question: Question;
  handover: Handover;
  integration: Integration;
}
export interface ProjectOrchApprovalSchemaJson {
  schemaVersion: 2;
  requestId: string;
  projectId: string;
  roleId: string;
  bindingEpoch: number;
  nativeApprovalId: string;
  expectedExecutionId: string;
  decision: "accept" | "decline" | "cancel";
}
export interface ProjectOrch {
  artifactId: string;
  version: string;
  offset: number;
  content: string;
  /**
   * content的显式编码；offset/nextOffset按原始字节计算，sha256为完整原始内容哈希。
   */
  encoding: "utf8" | "base64";
  nextOffset: number | null;
  sha256: string;
}
export interface ProjectOrchCapabilitiesSchemaJson {
  schemaVersion: 2;
  harnessId: string;
  hostId: string;
  adapterVersion: string;
  nativeVersion: string;
  protocolVersion: string;
  observedAt: string;
  capabilities: {
    attachExisting: {
      state: "verified" | "unverified" | "unsupported";
      semantics: string;
      /**
       * @minItems 0
       * @maxItems 64
       */
      evidenceRefs: string[];
    };
    readHistory: {
      state: "verified" | "unverified" | "unsupported";
      semantics: string;
      /**
       * @minItems 0
       * @maxItems 64
       */
      evidenceRefs: string[];
    };
    streamEvents: {
      state: "verified" | "unverified" | "unsupported";
      semantics: string;
      /**
       * @minItems 0
       * @maxItems 64
       */
      evidenceRefs: string[];
    };
    resumeEvents: {
      state: "verified" | "unverified" | "unsupported";
      semantics: string;
      /**
       * @minItems 0
       * @maxItems 64
       */
      evidenceRefs: string[];
    };
    wakeIdle: {
      state: "verified" | "unverified" | "unsupported";
      semantics: string;
      /**
       * @minItems 0
       * @maxItems 64
       */
      evidenceRefs: string[];
    };
    queueBusy: {
      state: "verified" | "unverified" | "unsupported";
      semantics: string;
      /**
       * @minItems 0
       * @maxItems 64
       */
      evidenceRefs: string[];
    };
    steerActive: {
      state: "verified" | "unverified" | "unsupported";
      semantics: string;
      /**
       * @minItems 0
       * @maxItems 64
       */
      evidenceRefs: string[];
    };
    interrupt: {
      state: "verified" | "unverified" | "unsupported";
      semantics: string;
      /**
       * @minItems 0
       * @maxItems 64
       */
      evidenceRefs: string[];
    };
    deduplicateCommand: {
      state: "verified" | "unverified" | "unsupported";
      semantics: string;
      /**
       * @minItems 0
       * @maxItems 64
       */
      evidenceRefs: string[];
    };
    trustedCallerIdentity: {
      state: "verified" | "unverified" | "unsupported";
      semantics: string;
      /**
       * @minItems 0
       * @maxItems 64
       */
      evidenceRefs: string[];
    };
    nativeApprovals: {
      state: "verified" | "unverified" | "unsupported";
      semantics: string;
      /**
       * @minItems 0
       * @maxItems 64
       */
      evidenceRefs: string[];
    };
    createSession: {
      state: "verified" | "unverified" | "unsupported";
      semantics: string;
      /**
       * @minItems 0
       * @maxItems 64
       */
      evidenceRefs: string[];
    };
    openNativeSession: {
      state: "verified" | "unverified" | "unsupported";
      semantics: string;
      /**
       * @minItems 0
       * @maxItems 64
       */
      evidenceRefs: string[];
    };
  };
}
export interface ProjectOrchChangesetSchemaJson {
  schemaVersion: 2;
  requestId: string;
  projectId: string;
  caseId?: string;
  expectedPlanRevision: number;
  reason: string;
  /**
   * @minItems 1
   * @maxItems 64
   */
  operations: [
    (
      | {
          type: "role.create";
          localRef: string;
          name: string;
          parentRoleId?: string;
          charter: string;
          /**
           * @minItems 0
           * @maxItems 128
           */
          scopePaths: string[];
          permissionProfileId: string;
          permissionProfileRevision: number;
        }
      | {
          type: "role.update";
          roleId: string;
          expectedRevision: number;
          charter: string;
          permissionProfileId?: string;
          permissionProfileRevision?: number;
        }
      | {
          type: "role.pause";
          roleId: string;
          expectedRevision: number;
          reason: string;
          currentWorkPolicy: "finish" | "request_stop" | "handoff";
        }
      | {
          type: "role.enable";
          roleId: string;
          expectedRevision: number;
          reason: string;
          currentWorkPolicy: "finish" | "request_stop" | "handoff";
        }
      | {
          type: "role.disable";
          roleId: string;
          expectedRevision: number;
          reason: string;
          currentWorkPolicy: "finish" | "request_stop" | "handoff";
        }
      | {
          type: "task.create";
          localRef: string;
          assigneeRoleId?: string;
          assigneeLocalRef?: string;
          spec: TaskSpec;
        }
      | ((
          | {
              [k: string]: unknown;
            }
          | {
              [k: string]: unknown;
            }
        ) & {
          type: "task.assign";
          taskId: string;
          expectedRevision: number;
          roleId?: string;
          roleLocalRef?: string;
        })
      | {
          type: "task.dependencies.replace";
          taskId: string;
          expectedRevision: number;
          /**
           * @minItems 0
           * @maxItems 128
           */
          dependencies: Dependency[];
          expectedSpecRevision: number;
          inFlightPolicy: "finish_stale" | "request_stop";
          /**
           * @minItems 0
           * @maxItems 128
           */
          affectedTaskIds: string[];
          reason: string;
        }
      | {
          type: "task.cancel";
          taskId: string;
          expectedRevision: number;
          reason: string;
        }
      | {
          type: "plan.revise";
          objective: string;
          /**
           * @minItems 0
           * @maxItems 512
           */
          affectedTaskIds: string[];
          rationale: string;
        }
      | {
          type: "case.assign";
          caseId: string;
          expectedRevision: number;
          roleId: string;
        }
      | {
          type: "task.spec.revise";
          taskId: string;
          expectedRevision: number;
          expectedSpecRevision: number;
          spec: TaskSpec;
          /**
           * @minItems 0
           * @maxItems 128
           */
          affectedTaskIds: string[];
          inFlightPolicy: "finish_stale" | "request_stop";
          outputReuse: "none" | "revalidate_only";
          reason: string;
        }
    ),
    ...(
      | {
          type: "role.create";
          localRef: string;
          name: string;
          parentRoleId?: string;
          charter: string;
          /**
           * @minItems 0
           * @maxItems 128
           */
          scopePaths: string[];
          permissionProfileId: string;
          permissionProfileRevision: number;
        }
      | {
          type: "role.update";
          roleId: string;
          expectedRevision: number;
          charter: string;
          permissionProfileId?: string;
          permissionProfileRevision?: number;
        }
      | {
          type: "role.pause";
          roleId: string;
          expectedRevision: number;
          reason: string;
          currentWorkPolicy: "finish" | "request_stop" | "handoff";
        }
      | {
          type: "role.enable";
          roleId: string;
          expectedRevision: number;
          reason: string;
          currentWorkPolicy: "finish" | "request_stop" | "handoff";
        }
      | {
          type: "role.disable";
          roleId: string;
          expectedRevision: number;
          reason: string;
          currentWorkPolicy: "finish" | "request_stop" | "handoff";
        }
      | {
          type: "task.create";
          localRef: string;
          assigneeRoleId?: string;
          assigneeLocalRef?: string;
          spec: TaskSpec;
        }
      | ((
          | {
              [k: string]: unknown;
            }
          | {
              [k: string]: unknown;
            }
        ) & {
          type: "task.assign";
          taskId: string;
          expectedRevision: number;
          roleId?: string;
          roleLocalRef?: string;
        })
      | {
          type: "task.dependencies.replace";
          taskId: string;
          expectedRevision: number;
          /**
           * @minItems 0
           * @maxItems 128
           */
          dependencies: Dependency[];
          expectedSpecRevision: number;
          inFlightPolicy: "finish_stale" | "request_stop";
          /**
           * @minItems 0
           * @maxItems 128
           */
          affectedTaskIds: string[];
          reason: string;
        }
      | {
          type: "task.cancel";
          taskId: string;
          expectedRevision: number;
          reason: string;
        }
      | {
          type: "plan.revise";
          objective: string;
          /**
           * @minItems 0
           * @maxItems 512
           */
          affectedTaskIds: string[];
          rationale: string;
        }
      | {
          type: "case.assign";
          caseId: string;
          expectedRevision: number;
          roleId: string;
        }
      | {
          type: "task.spec.revise";
          taskId: string;
          expectedRevision: number;
          expectedSpecRevision: number;
          spec: TaskSpec;
          /**
           * @minItems 0
           * @maxItems 128
           */
          affectedTaskIds: string[];
          inFlightPolicy: "finish_stale" | "request_stop";
          outputReuse: "none" | "revalidate_only";
          reason: string;
        }
    )[]
  ];
}
export interface TaskSpec {
  goal: string;
  /**
   * @minItems 0
   * @maxItems 128
   */
  inputArtifacts: ArtifactRef[];
  /**
   * @minItems 1
   * @maxItems 128
   */
  outputRequirements: [
    {
      name: string;
      kind: "file" | "report" | "git_commit";
      description: string;
    },
    ...{
      name: string;
      kind: "file" | "report" | "git_commit";
      description: string;
    }[]
  ];
  /**
   * @minItems 1
   * @maxItems 32
   */
  acceptance: [
    (
      | {
          ruleId: string;
          description: string;
          mode: "designated_reviewer";
          reviewerRoleId: string;
          independent: boolean;
        }
      | {
          ruleId: string;
          description: string;
          mode: "automated_check";
          checkDefinitionId: string;
          checkVersion: string;
          parameters: {
            [k: string]: unknown;
          };
        }
      | {
          ruleId: string;
          description: string;
          mode: "user";
        }
    ),
    ...(
      | {
          ruleId: string;
          description: string;
          mode: "designated_reviewer";
          reviewerRoleId: string;
          independent: boolean;
        }
      | {
          ruleId: string;
          description: string;
          mode: "automated_check";
          checkDefinitionId: string;
          checkVersion: string;
          parameters: {
            [k: string]: unknown;
          };
        }
      | {
          ruleId: string;
          description: string;
          mode: "user";
        }
    )[]
  ];
  /**
   * @minItems 0
   * @maxItems 128
   */
  dependencies: Dependency[];
}
export interface ArtifactRef {
  artifactId: string;
  version: string;
}
export interface Wait {
  target:
    | {
        kind: "message";
        messageId: string;
      }
    | {
        kind: "question";
        questionId: string;
        questionRevision: number;
      }
    | {
        kind: "task";
        taskId: string;
        taskRevision: number;
      }
    | {
        kind: "external";
        conditionId: string;
        conditionRevision: number;
        verifierRoleId: string;
      };
  deadline: string;
  onTimeout: "raise_issue" | "cancel_attempt";
  taskRevision: number;
  attemptId: string;
  bindingEpoch: number;
}
export interface Policy {
  id: string;
  revision: number;
  /**
   * @minItems 1
   * @maxItems 128
   */
  profiles: [PermissionProfile, ...PermissionProfile[]];
  limits: ExecutionLimits;
  nativeMode: "disabled" | "verified_only";
  writeIsolation: "exclusive_workspace" | "enforced_paths";
}
export interface PermissionProfile {
  id: string;
  revision: number;
  /**
   * @minItems 0
   * @maxItems 128
   */
  actions: string[];
  /**
   * @minItems 0
   * @maxItems 128
   */
  readPaths: string[];
  /**
   * @minItems 0
   * @maxItems 128
   */
  writePaths: string[];
  /**
   * @minItems 0
   * @maxItems 128
   */
  roleIds: string[];
  /**
   * @minItems 0
   * @maxItems 128
   */
  delegableActions: string[];
  maxDelegationDepth: number;
}
export interface ExecutionLimits {
  totalConcurrency: number;
  roleConcurrency: 1;
  maxAttempts: number;
  maxCorrectionTurns: number;
  maxManagementRounds: number;
  maxDynamicRoles: number;
  wallTimeMs: number;
  costCeiling: number | null;
  costEnforcement: "unavailable" | "advisory" | "harness_enforced";
}
export interface CheckDefinition {
  id: string;
  version: string;
  runner: "registered_process" | "registered_validator";
  entryId: string;
  entrySha256: string;
  parameterSchemaId: string;
  timeoutMs: number;
  /**
   * @minItems 0
   * @maxItems 128
   */
  permissions: string[];
  /**
   * @minItems 0
   * @maxItems 128
   */
  scopePaths: string[];
  enabled: boolean;
}
export interface ProjectOrchErrorSchemaJson {
  error: Detail;
}
export interface Detail {
  code:
    | "UNAUTHENTICATED"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "REVISION_CONFLICT"
    | "IDEMPOTENCY_CONFLICT"
    | "INVALID_STATE"
    | "DEPENDENCY_CYCLE"
    | "NATIVE_TARGET_CHANGED"
    | "CAPABILITY_UNSUPPORTED"
    | "ADAPTER_OFFLINE"
    | "DELIVERY_UNCERTAIN"
    | "BUDGET_EXCEEDED"
    | "VALIDATION_ERROR"
    | "INTERNAL_ERROR"
    | "STALE_SPEC"
    | "STALE_WAIT"
    | "DISPATCH_HELD"
    | "WORKSPACE_CONFLICT"
    | "CHECK_UNAVAILABLE"
    | "REVIEW_REQUIRED";
  message: string;
  requestId: string;
  retryable: boolean;
  details?: {
    [k: string]: unknown;
  };
}
export interface Source {
  kind: "authenticated_user" | "role_forwarded" | "native_unverified" | "kernel";
  principalId: string;
  originCommandId: string | null;
  sessionRef: {
    harnessId: string;
    hostId: string;
    profileId: string;
    nativeConversationId: string;
    nativeWorkspaceId?: string;
  } | null;
}
export interface HttpsProjectorchInvalidSchemasPairingSchemaJson {
  schemaVersion: 2;
  requestId: string;
  oneTimeCode: string;
  challengeId: string;
}
export interface ProjectOrchProjectCreateSchemaJson {
  schemaVersion: 2;
  requestId: string;
  name: string;
  hostId: string;
  rootPath: string;
  objective: string;
  initialPolicy: Policy;
}
export interface ProjectOrch1 {
  schemaVersion: 2;
  taskId: string;
  projectId: string;
  revision: number;
  specRevision: number;
  planRevision: number;
  userPaused: boolean;
  dependencyReady: boolean;
  blocks: {
    taskId: string;
    requiredRevision: number;
    currentRevision: number | null;
    reason:
      | "TASK_SPEC_REVALIDATION_REQUIRED"
      | "PREREQ_NOT_FOUND"
      | "PREREQ_SPEC_MISMATCH"
      | "PREREQ_CANCELLED"
      | "PREREQ_NOT_ACCEPTED"
      | "PREREQ_OUTPUT_NAME_MISSING"
      | "PREREQ_NO_ARTIFACT"
      | "PREREQ_CONDITION_UNSUPPORTED";
  }[];
  unresolvedAttempts: {
    attemptId: string;
    specRevision: number;
    state: "dispatching" | "running" | "waiting_input" | "unknown";
  }[];
}
export interface TaskDetail {
  id: string;
  projectId: string;
  revision: number;
  specRevision: number;
  planRevision: number;
  roleId: string | null;
  state: "draft" | "ready" | "active" | "waiting" | "review" | "accepted" | "blocked" | "cancelled";
  spec: TaskSpec;
  currentAttempt: Attempt | null;
  wait: Wait | null;
  /**
   * @minItems 0
   * @maxItems 128
   */
  resultIds: string[];
  /**
   * @minItems 0
   * @maxItems 128
   */
  integrationIds: string[];
}
export interface Attempt {
  id: string;
  taskId: string;
  taskRevision: number;
  bindingEpoch: number;
  workspaceId: string;
  state: "dispatching" | "running" | "waiting_input" | "succeeded" | "failed" | "interrupted" | "unknown";
  nativeExecutionId: string | null;
}
export interface Question {
  id: string;
  projectId: string;
  revision: number;
  taskId: string;
  taskRevision: number;
  attemptId: string;
  bindingEpoch: number;
  prompt: string;
  answerer:
    | {
        kind: "user";
      }
    | {
        kind: "role";
        roleId: string;
      };
  deadline: string;
  onTimeout: "raise_issue" | "cancel_attempt";
  state: "open" | "answered" | "expired" | "cancelled";
  answer: string | null;
}
export interface Handover {
  id: string;
  projectId: string;
  roleId: string;
  fromBindingEpoch: number;
  revision: number;
  planRevision: number;
  artifact: ArtifactRef;
  /**
   * @minItems 0
   * @maxItems 128
   */
  taskSpecRevisions: {
    taskId: string;
    specRevision: number;
  }[];
  /**
   * @minItems 0
   * @maxItems 128
   */
  workspaceVersions: {
    workspaceId: string;
    contentHash: string;
  }[];
  /**
   * @minItems 0
   * @maxItems 128
   */
  unresolvedIssueIds: string[];
  /**
   * @minItems 0
   * @maxItems 128
   */
  pendingEffects: string[];
  verifierRoleId: string;
  state: "prepared" | "verified" | "consumed" | "stale";
}
export interface Integration {
  id: string;
  projectId: string;
  revision: number;
  taskId: string;
  targetWorkspaceId: string;
  targetVersion: string;
  /**
   * @minItems 1
   * @maxItems 128
   */
  artifacts: [ArtifactRef, ...ArtifactRef[]];
  /**
   * @minItems 1
   * @maxItems 128
   */
  checkRefs: [
    {
      id: string;
      version: string;
    },
    ...{
      id: string;
      version: string;
    }[]
  ];
  state: "pending" | "integrating" | "verified" | "failed";
  /**
   * @minItems 0
   * @maxItems 128
   */
  evidence: ArtifactRef[];
  outputTarget?: {
    id: string;
    kind: "files" | "git";
    outputVersion: string;
    contentHash: string;
    resultId: string;
    contentPath?: string | null;
  };
  /**
   * @minItems 1
   * @maxItems 16
   */
  checkRuns?: [
    {
      id: string;
      checkId: string;
      checkVersion: string;
      outcome: "passed" | "failed";
      evidenceSha256: string;
    },
    ...{
      id: string;
      checkId: string;
      checkVersion: string;
      outcome: "passed" | "failed";
      evidenceSha256: string;
    }[]
  ];
  review?: {
    id: string;
    decision: "accept" | "reject";
    reviewerRoleId: string;
    repairTaskId: string | null;
    targetChanged: boolean;
  };
}
