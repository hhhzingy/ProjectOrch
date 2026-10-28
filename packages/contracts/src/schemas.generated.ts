/** 由 scripts/generate-contracts.mjs 从固定 Schema 生成，勿手改。Schema SHA-256: 96b3f5a17c6aa37f3d602064484a01468d9a5b61edeb0f733b5bd9a159e5180f。类型不替代运行时约束、授权或原生验收。 */
export const schemaFingerprint = "96b3f5a17c6aa37f3d602064484a01468d9a5b61edeb0f733b5bd9a159e5180f";
export const schemaDocuments: readonly object[] = [
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/approval.schema.json",
    "title": "ProjectOrch approval.schema.json",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "const": 2
      },
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "projectId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "roleId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "bindingEpoch": {
        "type": "integer",
        "minimum": 1
      },
      "nativeApprovalId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 512
      },
      "expectedExecutionId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 512
      },
      "decision": {
        "type": "string",
        "enum": [
          "accept",
          "decline",
          "cancel"
        ]
      }
    },
    "required": [
      "schemaVersion",
      "requestId",
      "projectId",
      "roleId",
      "bindingEpoch",
      "nativeApprovalId",
      "expectedExecutionId",
      "decision"
    ],
    "additionalProperties": false
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/artifact-chunk.schema.json",
    "title": "ProjectOrch成果内容分片",
    "type": "object",
    "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ArtifactChunk"
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/capabilities.schema.json",
    "title": "ProjectOrch capabilities.schema.json",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "const": 2
      },
      "harnessId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "hostId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "adapterVersion": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "nativeVersion": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "protocolVersion": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "observedAt": {
        "type": "string",
        "format": "date-time"
      },
      "capabilities": {
        "type": "object",
        "properties": {
          "attachExisting": {
            "type": "object",
            "properties": {
              "state": {
                "type": "string",
                "enum": [
                  "verified",
                  "unverified",
                  "unsupported"
                ]
              },
              "semantics": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "evidenceRefs": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2048
                },
                "minItems": 0,
                "maxItems": 64
              }
            },
            "required": [
              "state",
              "semantics",
              "evidenceRefs"
            ],
            "additionalProperties": false,
            "allOf": [
              {
                "if": {
                  "properties": {
                    "state": {
                      "const": "verified"
                    }
                  },
                  "required": [
                    "state"
                  ]
                },
                "then": {
                  "properties": {
                    "evidenceRefs": {
                      "minItems": 1
                    }
                  }
                }
              }
            ]
          },
          "readHistory": {
            "type": "object",
            "properties": {
              "state": {
                "type": "string",
                "enum": [
                  "verified",
                  "unverified",
                  "unsupported"
                ]
              },
              "semantics": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "evidenceRefs": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2048
                },
                "minItems": 0,
                "maxItems": 64
              }
            },
            "required": [
              "state",
              "semantics",
              "evidenceRefs"
            ],
            "additionalProperties": false,
            "allOf": [
              {
                "if": {
                  "properties": {
                    "state": {
                      "const": "verified"
                    }
                  },
                  "required": [
                    "state"
                  ]
                },
                "then": {
                  "properties": {
                    "evidenceRefs": {
                      "minItems": 1
                    }
                  }
                }
              }
            ]
          },
          "streamEvents": {
            "type": "object",
            "properties": {
              "state": {
                "type": "string",
                "enum": [
                  "verified",
                  "unverified",
                  "unsupported"
                ]
              },
              "semantics": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "evidenceRefs": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2048
                },
                "minItems": 0,
                "maxItems": 64
              }
            },
            "required": [
              "state",
              "semantics",
              "evidenceRefs"
            ],
            "additionalProperties": false,
            "allOf": [
              {
                "if": {
                  "properties": {
                    "state": {
                      "const": "verified"
                    }
                  },
                  "required": [
                    "state"
                  ]
                },
                "then": {
                  "properties": {
                    "evidenceRefs": {
                      "minItems": 1
                    }
                  }
                }
              }
            ]
          },
          "resumeEvents": {
            "type": "object",
            "properties": {
              "state": {
                "type": "string",
                "enum": [
                  "verified",
                  "unverified",
                  "unsupported"
                ]
              },
              "semantics": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "evidenceRefs": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2048
                },
                "minItems": 0,
                "maxItems": 64
              }
            },
            "required": [
              "state",
              "semantics",
              "evidenceRefs"
            ],
            "additionalProperties": false,
            "allOf": [
              {
                "if": {
                  "properties": {
                    "state": {
                      "const": "verified"
                    }
                  },
                  "required": [
                    "state"
                  ]
                },
                "then": {
                  "properties": {
                    "evidenceRefs": {
                      "minItems": 1
                    }
                  }
                }
              }
            ]
          },
          "wakeIdle": {
            "type": "object",
            "properties": {
              "state": {
                "type": "string",
                "enum": [
                  "verified",
                  "unverified",
                  "unsupported"
                ]
              },
              "semantics": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "evidenceRefs": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2048
                },
                "minItems": 0,
                "maxItems": 64
              }
            },
            "required": [
              "state",
              "semantics",
              "evidenceRefs"
            ],
            "additionalProperties": false,
            "allOf": [
              {
                "if": {
                  "properties": {
                    "state": {
                      "const": "verified"
                    }
                  },
                  "required": [
                    "state"
                  ]
                },
                "then": {
                  "properties": {
                    "evidenceRefs": {
                      "minItems": 1
                    }
                  }
                }
              }
            ]
          },
          "queueBusy": {
            "type": "object",
            "properties": {
              "state": {
                "type": "string",
                "enum": [
                  "verified",
                  "unverified",
                  "unsupported"
                ]
              },
              "semantics": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "evidenceRefs": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2048
                },
                "minItems": 0,
                "maxItems": 64
              }
            },
            "required": [
              "state",
              "semantics",
              "evidenceRefs"
            ],
            "additionalProperties": false,
            "allOf": [
              {
                "if": {
                  "properties": {
                    "state": {
                      "const": "verified"
                    }
                  },
                  "required": [
                    "state"
                  ]
                },
                "then": {
                  "properties": {
                    "evidenceRefs": {
                      "minItems": 1
                    }
                  }
                }
              }
            ]
          },
          "steerActive": {
            "type": "object",
            "properties": {
              "state": {
                "type": "string",
                "enum": [
                  "verified",
                  "unverified",
                  "unsupported"
                ]
              },
              "semantics": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "evidenceRefs": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2048
                },
                "minItems": 0,
                "maxItems": 64
              }
            },
            "required": [
              "state",
              "semantics",
              "evidenceRefs"
            ],
            "additionalProperties": false,
            "allOf": [
              {
                "if": {
                  "properties": {
                    "state": {
                      "const": "verified"
                    }
                  },
                  "required": [
                    "state"
                  ]
                },
                "then": {
                  "properties": {
                    "evidenceRefs": {
                      "minItems": 1
                    }
                  }
                }
              }
            ]
          },
          "interrupt": {
            "type": "object",
            "properties": {
              "state": {
                "type": "string",
                "enum": [
                  "verified",
                  "unverified",
                  "unsupported"
                ]
              },
              "semantics": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "evidenceRefs": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2048
                },
                "minItems": 0,
                "maxItems": 64
              }
            },
            "required": [
              "state",
              "semantics",
              "evidenceRefs"
            ],
            "additionalProperties": false,
            "allOf": [
              {
                "if": {
                  "properties": {
                    "state": {
                      "const": "verified"
                    }
                  },
                  "required": [
                    "state"
                  ]
                },
                "then": {
                  "properties": {
                    "evidenceRefs": {
                      "minItems": 1
                    }
                  }
                }
              }
            ]
          },
          "deduplicateCommand": {
            "type": "object",
            "properties": {
              "state": {
                "type": "string",
                "enum": [
                  "verified",
                  "unverified",
                  "unsupported"
                ]
              },
              "semantics": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "evidenceRefs": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2048
                },
                "minItems": 0,
                "maxItems": 64
              }
            },
            "required": [
              "state",
              "semantics",
              "evidenceRefs"
            ],
            "additionalProperties": false,
            "allOf": [
              {
                "if": {
                  "properties": {
                    "state": {
                      "const": "verified"
                    }
                  },
                  "required": [
                    "state"
                  ]
                },
                "then": {
                  "properties": {
                    "evidenceRefs": {
                      "minItems": 1
                    }
                  }
                }
              }
            ]
          },
          "trustedCallerIdentity": {
            "type": "object",
            "properties": {
              "state": {
                "type": "string",
                "enum": [
                  "verified",
                  "unverified",
                  "unsupported"
                ]
              },
              "semantics": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "evidenceRefs": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2048
                },
                "minItems": 0,
                "maxItems": 64
              }
            },
            "required": [
              "state",
              "semantics",
              "evidenceRefs"
            ],
            "additionalProperties": false,
            "allOf": [
              {
                "if": {
                  "properties": {
                    "state": {
                      "const": "verified"
                    }
                  },
                  "required": [
                    "state"
                  ]
                },
                "then": {
                  "properties": {
                    "evidenceRefs": {
                      "minItems": 1
                    }
                  }
                }
              }
            ]
          },
          "nativeApprovals": {
            "type": "object",
            "properties": {
              "state": {
                "type": "string",
                "enum": [
                  "verified",
                  "unverified",
                  "unsupported"
                ]
              },
              "semantics": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "evidenceRefs": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2048
                },
                "minItems": 0,
                "maxItems": 64
              }
            },
            "required": [
              "state",
              "semantics",
              "evidenceRefs"
            ],
            "additionalProperties": false,
            "allOf": [
              {
                "if": {
                  "properties": {
                    "state": {
                      "const": "verified"
                    }
                  },
                  "required": [
                    "state"
                  ]
                },
                "then": {
                  "properties": {
                    "evidenceRefs": {
                      "minItems": 1
                    }
                  }
                }
              }
            ]
          },
          "createSession": {
            "type": "object",
            "properties": {
              "state": {
                "type": "string",
                "enum": [
                  "verified",
                  "unverified",
                  "unsupported"
                ]
              },
              "semantics": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "evidenceRefs": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2048
                },
                "minItems": 0,
                "maxItems": 64
              }
            },
            "required": [
              "state",
              "semantics",
              "evidenceRefs"
            ],
            "additionalProperties": false,
            "allOf": [
              {
                "if": {
                  "properties": {
                    "state": {
                      "const": "verified"
                    }
                  },
                  "required": [
                    "state"
                  ]
                },
                "then": {
                  "properties": {
                    "evidenceRefs": {
                      "minItems": 1
                    }
                  }
                }
              }
            ]
          },
          "openNativeSession": {
            "type": "object",
            "properties": {
              "state": {
                "type": "string",
                "enum": [
                  "verified",
                  "unverified",
                  "unsupported"
                ]
              },
              "semantics": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "evidenceRefs": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2048
                },
                "minItems": 0,
                "maxItems": 64
              }
            },
            "required": [
              "state",
              "semantics",
              "evidenceRefs"
            ],
            "additionalProperties": false,
            "allOf": [
              {
                "if": {
                  "properties": {
                    "state": {
                      "const": "verified"
                    }
                  },
                  "required": [
                    "state"
                  ]
                },
                "then": {
                  "properties": {
                    "evidenceRefs": {
                      "minItems": 1
                    }
                  }
                }
              }
            ]
          }
        },
        "required": [
          "attachExisting",
          "readHistory",
          "streamEvents",
          "resumeEvents",
          "wakeIdle",
          "queueBusy",
          "steerActive",
          "interrupt",
          "deduplicateCommand",
          "trustedCallerIdentity",
          "nativeApprovals",
          "createSession",
          "openNativeSession"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "schemaVersion",
      "harnessId",
      "hostId",
      "adapterVersion",
      "nativeVersion",
      "protocolVersion",
      "observedAt",
      "capabilities"
    ],
    "additionalProperties": false
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/changeset.schema.json",
    "title": "ProjectOrch changeset.schema.json",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "const": 2
      },
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "projectId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "caseId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "expectedPlanRevision": {
        "type": "integer",
        "minimum": 0
      },
      "reason": {
        "type": "string",
        "minLength": 1,
        "maxLength": 16384
      },
      "operations": {
        "type": "array",
        "items": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "type": {
                  "const": "role.create"
                },
                "localRef": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "name": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 256
                },
                "parentRoleId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "charter": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 16384
                },
                "scopePaths": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2048
                  },
                  "minItems": 0,
                  "maxItems": 128
                },
                "permissionProfileId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "permissionProfileRevision": {
                  "type": "integer",
                  "minimum": 0
                }
              },
              "required": [
                "type",
                "localRef",
                "name",
                "charter",
                "scopePaths",
                "permissionProfileId",
                "permissionProfileRevision"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "const": "role.update"
                },
                "roleId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "expectedRevision": {
                  "type": "integer",
                  "minimum": 0
                },
                "charter": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 16384
                },
                "permissionProfileId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "permissionProfileRevision": {
                  "type": "integer",
                  "minimum": 0
                }
              },
              "required": [
                "type",
                "roleId",
                "expectedRevision",
                "charter"
              ],
              "additionalProperties": false,
              "allOf": [
                {
                  "if": {
                    "required": [
                      "permissionProfileId"
                    ]
                  },
                  "then": {
                    "required": [
                      "permissionProfileRevision"
                    ]
                  }
                }
              ]
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "const": "role.pause"
                },
                "roleId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "expectedRevision": {
                  "type": "integer",
                  "minimum": 0
                },
                "reason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 8192
                },
                "currentWorkPolicy": {
                  "type": "string",
                  "enum": [
                    "finish",
                    "request_stop",
                    "handoff"
                  ]
                }
              },
              "required": [
                "type",
                "roleId",
                "expectedRevision",
                "reason",
                "currentWorkPolicy"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "const": "role.enable"
                },
                "roleId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "expectedRevision": {
                  "type": "integer",
                  "minimum": 0
                },
                "reason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 8192
                },
                "currentWorkPolicy": {
                  "type": "string",
                  "enum": [
                    "finish",
                    "request_stop",
                    "handoff"
                  ]
                }
              },
              "required": [
                "type",
                "roleId",
                "expectedRevision",
                "reason",
                "currentWorkPolicy"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "const": "role.disable"
                },
                "roleId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "expectedRevision": {
                  "type": "integer",
                  "minimum": 0
                },
                "reason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 8192
                },
                "currentWorkPolicy": {
                  "type": "string",
                  "enum": [
                    "finish",
                    "request_stop",
                    "handoff"
                  ]
                }
              },
              "required": [
                "type",
                "roleId",
                "expectedRevision",
                "reason",
                "currentWorkPolicy"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "const": "task.create"
                },
                "localRef": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "assigneeRoleId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "assigneeLocalRef": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "spec": {
                  "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/TaskSpec"
                }
              },
              "required": [
                "type",
                "localRef",
                "spec"
              ],
              "additionalProperties": false,
              "not": {
                "required": [
                  "assigneeRoleId",
                  "assigneeLocalRef"
                ]
              }
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "const": "task.assign"
                },
                "taskId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "expectedRevision": {
                  "type": "integer",
                  "minimum": 0
                },
                "roleId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "roleLocalRef": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                }
              },
              "required": [
                "type",
                "taskId",
                "expectedRevision"
              ],
              "additionalProperties": false,
              "oneOf": [
                {
                  "required": [
                    "roleId"
                  ],
                  "not": {
                    "required": [
                      "roleLocalRef"
                    ]
                  }
                },
                {
                  "required": [
                    "roleLocalRef"
                  ],
                  "not": {
                    "required": [
                      "roleId"
                    ]
                  }
                }
              ]
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "const": "task.dependencies.replace"
                },
                "taskId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "expectedRevision": {
                  "type": "integer",
                  "minimum": 0
                },
                "dependencies": {
                  "type": "array",
                  "items": {
                    "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Dependency"
                  },
                  "minItems": 0,
                  "maxItems": 128
                },
                "expectedSpecRevision": {
                  "type": "integer",
                  "minimum": 0
                },
                "inFlightPolicy": {
                  "type": "string",
                  "enum": [
                    "finish_stale",
                    "request_stop"
                  ]
                },
                "affectedTaskIds": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "minItems": 0,
                  "maxItems": 128
                },
                "reason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 16384
                }
              },
              "required": [
                "type",
                "taskId",
                "expectedRevision",
                "dependencies",
                "expectedSpecRevision",
                "inFlightPolicy",
                "affectedTaskIds",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "const": "task.cancel"
                },
                "taskId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "expectedRevision": {
                  "type": "integer",
                  "minimum": 0
                },
                "reason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 8192
                }
              },
              "required": [
                "type",
                "taskId",
                "expectedRevision",
                "reason"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "const": "plan.revise"
                },
                "objective": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 16384
                },
                "affectedTaskIds": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "minItems": 0,
                  "maxItems": 512
                },
                "rationale": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 16384
                }
              },
              "required": [
                "type",
                "objective",
                "affectedTaskIds",
                "rationale"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "const": "case.assign"
                },
                "caseId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "expectedRevision": {
                  "type": "integer",
                  "minimum": 0
                },
                "roleId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                }
              },
              "required": [
                "type",
                "caseId",
                "expectedRevision",
                "roleId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "type": {
                  "const": "task.spec.revise"
                },
                "taskId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "expectedRevision": {
                  "type": "integer",
                  "minimum": 0
                },
                "expectedSpecRevision": {
                  "type": "integer",
                  "minimum": 0
                },
                "spec": {
                  "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/TaskSpec"
                },
                "affectedTaskIds": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "minItems": 0,
                  "maxItems": 128
                },
                "inFlightPolicy": {
                  "type": "string",
                  "enum": [
                    "finish_stale",
                    "request_stop"
                  ]
                },
                "outputReuse": {
                  "type": "string",
                  "enum": [
                    "none",
                    "revalidate_only"
                  ]
                },
                "reason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 16384
                }
              },
              "required": [
                "type",
                "taskId",
                "expectedRevision",
                "expectedSpecRevision",
                "spec",
                "affectedTaskIds",
                "inFlightPolicy",
                "outputReuse",
                "reason"
              ],
              "additionalProperties": false
            }
          ]
        },
        "minItems": 1,
        "maxItems": 64
      }
    },
    "required": [
      "schemaVersion",
      "requestId",
      "projectId",
      "expectedPlanRevision",
      "reason",
      "operations"
    ],
    "additionalProperties": false
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/command.schema.json",
    "title": "ProjectOrch command.schema.json",
    "oneOf": [
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "task.claim"
          },
          "payload": {
            "type": "object",
            "properties": {
              "taskId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "expectedRevision": {
                "type": "integer",
                "minimum": 0
              },
              "expectedSpecRevision": {
                "type": "integer",
                "minimum": 0
              }
            },
            "required": [
              "taskId",
              "expectedRevision",
              "expectedSpecRevision"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "task.report"
          },
          "payload": {
            "type": "object",
            "properties": {
              "taskId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "attemptId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "bindingEpoch": {
                "type": "integer",
                "minimum": 1
              },
              "report": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16384
              },
              "wait": {
                "anyOf": [
                  {
                    "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Wait"
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "taskId",
              "attemptId",
              "bindingEpoch",
              "report",
              "wait"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "task.accept"
          },
          "payload": {
            "type": "object",
            "properties": {
              "taskId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "taskRevision": {
                "type": "integer",
                "minimum": 0
              },
              "resultId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "decision": {
                "type": "string",
                "enum": [
                  "accept",
                  "reject",
                  "needs_evidence"
                ]
              },
              "reason": {
                "type": "string",
                "minLength": 1,
                "maxLength": 8192
              },
              "evidenceArtifactIds": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "minItems": 0,
                "maxItems": 128
              },
              "ruleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "taskId",
              "taskRevision",
              "resultId",
              "decision",
              "reason",
              "evidenceArtifactIds",
              "ruleId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "role.bind"
          },
          "payload": {
            "type": "object",
            "properties": {
              "roleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "expectedRevision": {
                "type": "integer",
                "minimum": 0
              },
              "sessionRef": {
                "type": "object",
                "properties": {
                  "harnessId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "hostId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "profileId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "nativeConversationId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 512
                  },
                  "nativeWorkspaceId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 512
                  }
                },
                "required": [
                  "harnessId",
                  "hostId",
                  "profileId",
                  "nativeConversationId"
                ],
                "additionalProperties": false
              },
              "handoverId": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "roleId",
              "expectedRevision",
              "sessionRef",
              "handoverId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "issue.raise"
          },
          "payload": {
            "type": "object",
            "properties": {
              "taskId": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "category": {
                "type": "string",
                "enum": [
                  "transport",
                  "dependency",
                  "capacity",
                  "technical",
                  "scope",
                  "identity",
                  "unknown"
                ]
              },
              "summary": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16384
              },
              "evidenceArtifactIds": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "minItems": 0,
                "maxItems": 128
              }
            },
            "required": [
              "taskId",
              "category",
              "summary",
              "evidenceArtifactIds"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "message.ack"
          },
          "payload": {
            "type": "object",
            "properties": {
              "messageId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "state": {
                "type": "string",
                "enum": [
                  "acknowledged",
                  "resolved"
                ]
              },
              "bindingEpoch": {
                "type": "integer",
                "minimum": 1
              }
            },
            "required": [
              "messageId",
              "state",
              "bindingEpoch"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "artifact.register"
          },
          "payload": {
            "oneOf": [
              {
                "type": "object",
                "properties": {
                  "taskId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "kind": {
                    "enum": [
                      "file",
                      "report"
                    ]
                  },
                  "path": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 4096
                  },
                  "sha256": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "byteSize": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "taskRevision": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": [
                  "taskId",
                  "kind",
                  "path",
                  "sha256",
                  "byteSize",
                  "taskRevision"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "taskId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "kind": {
                    "const": "git_commit"
                  },
                  "repositoryPath": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 4096
                  },
                  "commitId": {
                    "type": "string",
                    "pattern": "^([a-f0-9]{40}|[a-f0-9]{64})$"
                  },
                  "taskRevision": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": [
                  "taskId",
                  "kind",
                  "repositoryPath",
                  "commitId",
                  "taskRevision"
                ],
                "additionalProperties": false
              }
            ]
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "project.pause"
          },
          "payload": {
            "type": "object",
            "properties": {
              "reason": {
                "type": "string",
                "minLength": 1,
                "maxLength": 8192
              },
              "currentWorkPolicy": {
                "type": "string",
                "enum": [
                  "finish",
                  "request_stop"
                ]
              }
            },
            "required": [
              "reason",
              "currentWorkPolicy"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "project.resume"
          },
          "payload": {
            "type": "object",
            "properties": {
              "expectedRevision": {
                "type": "integer",
                "minimum": 0
              },
              "reason": {
                "type": "string",
                "minLength": 1,
                "maxLength": 8192
              }
            },
            "required": [
              "expectedRevision",
              "reason"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "role.bootstrap"
          },
          "payload": {
            "type": "object",
            "properties": {
              "localRef": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "charter": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16384
              },
              "permissionProfileId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "permissionProfileRevision": {
                "type": "integer",
                "minimum": 0
              },
              "expectedPolicyRevision": {
                "type": "integer",
                "minimum": 0
              },
              "sessionRef": {
                "type": "object",
                "properties": {
                  "harnessId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "hostId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "profileId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "nativeConversationId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 512
                  },
                  "nativeWorkspaceId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 512
                  }
                },
                "required": [
                  "harnessId",
                  "hostId",
                  "profileId",
                  "nativeConversationId"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "localRef",
              "name",
              "charter",
              "permissionProfileId",
              "permissionProfileRevision",
              "expectedPolicyRevision",
              "sessionRef"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "policy.configure"
          },
          "payload": {
            "type": "object",
            "properties": {
              "expectedRevision": {
                "type": "integer",
                "minimum": 0
              },
              "policy": {
                "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Policy"
              }
            },
            "required": [
              "expectedRevision",
              "policy"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "check.register"
          },
          "payload": {
            "type": "object",
            "properties": {
              "definition": {
                "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/CheckDefinition"
              }
            },
            "required": [
              "definition"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "result.revalidate"
          },
          "payload": {
            "type": "object",
            "properties": {
              "taskId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "expectedRevision": {
                "type": "integer",
                "minimum": 0
              },
              "oldResultId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "targetSpecRevision": {
                "type": "integer",
                "minimum": 0
              },
              "reason": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16384
              }
            },
            "required": [
              "taskId",
              "expectedRevision",
              "oldResultId",
              "targetSpecRevision",
              "reason"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "question.ask"
          },
          "payload": {
            "type": "object",
            "properties": {
              "taskId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "taskRevision": {
                "type": "integer",
                "minimum": 0
              },
              "attemptId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "bindingEpoch": {
                "type": "integer",
                "minimum": 1
              },
              "prompt": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16384
              },
              "answerer": {
                "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Answerer"
              },
              "deadline": {
                "type": "string",
                "format": "date-time"
              },
              "onTimeout": {
                "type": "string",
                "enum": [
                  "raise_issue",
                  "cancel_attempt"
                ]
              }
            },
            "required": [
              "taskId",
              "taskRevision",
              "attemptId",
              "bindingEpoch",
              "prompt",
              "answerer",
              "deadline",
              "onTimeout"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "question.answer"
          },
          "payload": {
            "type": "object",
            "properties": {
              "questionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "expectedRevision": {
                "type": "integer",
                "minimum": 0
              },
              "answer": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16384
              }
            },
            "required": [
              "questionId",
              "expectedRevision",
              "answer"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "condition.verify"
          },
          "payload": {
            "type": "object",
            "properties": {
              "conditionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "expectedRevision": {
                "type": "integer",
                "minimum": 0
              },
              "decision": {
                "type": "string",
                "enum": [
                  "satisfied",
                  "unsatisfied"
                ]
              },
              "evidence": {
                "type": "array",
                "items": {
                  "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ArtifactRef"
                },
                "minItems": 1,
                "maxItems": 128
              }
            },
            "required": [
              "conditionId",
              "expectedRevision",
              "decision",
              "evidence"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "issue.resolve"
          },
          "payload": {
            "type": "object",
            "properties": {
              "caseId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "expectedRevision": {
                "type": "integer",
                "minimum": 0
              },
              "decision": {
                "type": "string",
                "enum": [
                  "resolved",
                  "escalated"
                ]
              },
              "reason": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16384
              },
              "evidence": {
                "type": "array",
                "items": {
                  "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ArtifactRef"
                },
                "minItems": 1,
                "maxItems": 128
              }
            },
            "required": [
              "caseId",
              "expectedRevision",
              "decision",
              "reason",
              "evidence"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "goal.resolve"
          },
          "payload": {
            "type": "object",
            "properties": {
              "holdId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "expectedRevision": {
                "type": "integer",
                "minimum": 0
              },
              "expectedPlanRevision": {
                "type": "integer",
                "minimum": 0
              },
              "affectedTaskIds": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "minItems": 0,
                "maxItems": 128
              },
              "decision": {
                "type": "string",
                "enum": [
                  "apply_revision",
                  "dismiss_untrusted",
                  "request_user"
                ]
              },
              "changesetId": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "reason": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16384
              }
            },
            "required": [
              "holdId",
              "expectedRevision",
              "expectedPlanRevision",
              "affectedTaskIds",
              "decision",
              "changesetId",
              "reason"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "workspace.register"
          },
          "payload": {
            "type": "object",
            "properties": {
              "localRef": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "path": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "kind": {
                "type": "string",
                "enum": [
                  "git",
                  "directory"
                ]
              },
              "writePaths": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2048
                },
                "minItems": 0,
                "maxItems": 128
              },
              "managed": {
                "type": "boolean"
              }
            },
            "required": [
              "localRef",
              "path",
              "kind",
              "writePaths",
              "managed"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "workspace.reserve"
          },
          "payload": {
            "type": "object",
            "properties": {
              "workspaceId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "expectedRevision": {
                "type": "integer",
                "minimum": 0
              },
              "taskId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "taskRevision": {
                "type": "integer",
                "minimum": 0
              }
            },
            "required": [
              "workspaceId",
              "expectedRevision",
              "taskId",
              "taskRevision"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "workspace.release"
          },
          "payload": {
            "type": "object",
            "properties": {
              "workspaceId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "expectedRevision": {
                "type": "integer",
                "minimum": 0
              },
              "reason": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16384
              }
            },
            "required": [
              "workspaceId",
              "expectedRevision",
              "reason"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "handover.prepare"
          },
          "payload": {
            "type": "object",
            "properties": {
              "roleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "expectedBindingEpoch": {
                "type": "integer",
                "minimum": 1
              },
              "artifact": {
                "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ArtifactRef"
              },
              "taskSpecRevisions": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "taskId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    },
                    "specRevision": {
                      "type": "integer",
                      "minimum": 0
                    }
                  },
                  "required": [
                    "taskId",
                    "specRevision"
                  ],
                  "additionalProperties": false
                },
                "minItems": 0,
                "maxItems": 128
              },
              "workspaceVersions": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "workspaceId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    },
                    "contentHash": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    }
                  },
                  "required": [
                    "workspaceId",
                    "contentHash"
                  ],
                  "additionalProperties": false
                },
                "minItems": 0,
                "maxItems": 128
              },
              "unresolvedIssueIds": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "minItems": 0,
                "maxItems": 128
              },
              "pendingEffects": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "minItems": 0,
                "maxItems": 128
              },
              "verifierRoleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "roleId",
              "expectedBindingEpoch",
              "artifact",
              "taskSpecRevisions",
              "workspaceVersions",
              "unresolvedIssueIds",
              "pendingEffects",
              "verifierRoleId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "handover.verify"
          },
          "payload": {
            "type": "object",
            "properties": {
              "handoverId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "expectedRevision": {
                "type": "integer",
                "minimum": 0
              },
              "decision": {
                "type": "string",
                "enum": [
                  "verified",
                  "stale"
                ]
              },
              "evidence": {
                "type": "array",
                "items": {
                  "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ArtifactRef"
                },
                "minItems": 1,
                "maxItems": 128
              }
            },
            "required": [
              "handoverId",
              "expectedRevision",
              "decision",
              "evidence"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "integration.request"
          },
          "payload": {
            "type": "object",
            "properties": {
              "taskId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "taskRevision": {
                "type": "integer",
                "minimum": 0
              },
              "targetWorkspaceId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "targetVersion": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "artifacts": {
                "type": "array",
                "items": {
                  "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ArtifactRef"
                },
                "minItems": 1,
                "maxItems": 128
              },
              "checkRefs": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    },
                    "version": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  },
                  "required": [
                    "id",
                    "version"
                  ],
                  "additionalProperties": false
                },
                "minItems": 1,
                "maxItems": 128
              }
            },
            "required": [
              "taskId",
              "taskRevision",
              "targetWorkspaceId",
              "targetVersion",
              "artifacts",
              "checkRefs"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "role.startup_ack"
          },
          "payload": {
            "type": "object",
            "properties": {
              "roleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "bindingEpoch": {
                "type": "integer",
                "minimum": 1
              },
              "protocolVersion": {
                "const": 2
              },
              "policyRevision": {
                "type": "integer",
                "minimum": 0
              },
              "planRevision": {
                "type": "integer",
                "minimum": 0
              },
              "taskSpecRevisions": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "taskId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    },
                    "specRevision": {
                      "type": "integer",
                      "minimum": 0
                    }
                  },
                  "required": [
                    "taskId",
                    "specRevision"
                  ],
                  "additionalProperties": false
                },
                "minItems": 0,
                "maxItems": 128
              },
              "roleRevision": {
                "type": "integer",
                "minimum": 0
              }
            },
            "required": [
              "roleId",
              "bindingEpoch",
              "protocolVersion",
              "policyRevision",
              "planRevision",
              "taskSpecRevisions",
              "roleRevision"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "native.input"
          },
          "payload": {
            "type": "object",
            "properties": {
              "roleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "bindingEpoch": {
                "type": "integer",
                "minimum": 1
              },
              "body": {
                "type": "string",
                "minLength": 1,
                "maxLength": 65536
              },
              "delivery": {
                "type": "object",
                "properties": {
                  "mode": {
                    "type": "string",
                    "enum": [
                      "inbox",
                      "when_available",
                      "steer_current",
                      "interrupt_then_deliver"
                    ]
                  },
                  "priority": {
                    "type": "string",
                    "enum": [
                      "normal",
                      "urgent"
                    ]
                  },
                  "expectedExecutionId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 512
                  },
                  "expectedBindingEpoch": {
                    "type": "integer",
                    "minimum": 1
                  },
                  "expiresAt": {
                    "type": "string",
                    "format": "date-time"
                  }
                },
                "required": [
                  "mode",
                  "priority"
                ],
                "additionalProperties": false,
                "allOf": [
                  {
                    "if": {
                      "properties": {
                        "mode": {
                          "enum": [
                            "steer_current",
                            "interrupt_then_deliver"
                          ]
                        }
                      },
                      "required": [
                        "mode"
                      ]
                    },
                    "then": {
                      "required": [
                        "expectedExecutionId",
                        "expectedBindingEpoch"
                      ]
                    }
                  }
                ]
              }
            },
            "required": [
              "roleId",
              "bindingEpoch",
              "body",
              "delivery"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "native.stop"
          },
          "payload": {
            "type": "object",
            "properties": {
              "roleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "bindingEpoch": {
                "type": "integer",
                "minimum": 1
              },
              "expectedExecutionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "reason": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16384
              }
            },
            "required": [
              "roleId",
              "bindingEpoch",
              "expectedExecutionId",
              "reason"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "role.provision"
          },
          "payload": {
            "type": "object",
            "properties": {
              "roleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "expectedRevision": {
                "type": "integer",
                "minimum": 0
              },
              "harnessId": {
                "type": "string",
                "enum": [
                  "codex",
                  "zcode"
                ]
              },
              "handoverId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128,
                "description": "显式新会话接替：消费当前已独立核验交接包；缺省仅允许未绑定子角色"
              }
            },
            "required": [
              "roleId",
              "expectedRevision",
              "harnessId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "integration.evaluate"
          },
          "payload": {
            "type": "object",
            "properties": {
              "integrationId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "expectedRevision": {
                "type": "integer",
                "minimum": 1
              },
              "resultId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "targetKind": {
                "enum": [
                  "files",
                  "git"
                ]
              },
              "checkParameters": {
                "type": "array",
                "minItems": 1,
                "maxItems": 16,
                "items": {
                  "type": "object",
                  "properties": {
                    "checkId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    },
                    "checkVersion": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    },
                    "parameters": {
                      "type": "object",
                      "properties": {
                        "files": {
                          "type": "array",
                          "minItems": 1,
                          "maxItems": 16,
                          "items": {
                            "type": "object",
                            "properties": {
                              "path": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 2048
                              },
                              "assertions": {
                                "type": "array",
                                "minItems": 1,
                                "maxItems": 64,
                                "items": {
                                  "type": "object",
                                  "properties": {
                                    "pointer": {
                                      "type": "string",
                                      "maxLength": 1024
                                    },
                                    "equals": {}
                                  },
                                  "required": [
                                    "pointer",
                                    "equals"
                                  ],
                                  "additionalProperties": false
                                }
                              }
                            },
                            "required": [
                              "path",
                              "assertions"
                            ],
                            "additionalProperties": false
                          }
                        }
                      },
                      "required": [
                        "files"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "required": [
                    "checkId",
                    "checkVersion",
                    "parameters"
                  ],
                  "additionalProperties": false
                }
              },
              "contentPath": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2048,
                "description": "明确选择目标工作区内交付内容子目录；不传表示整个工作区，遇Harness运行元数据明确拒绝，不静默跳过。"
              }
            },
            "required": [
              "integrationId",
              "expectedRevision",
              "resultId",
              "targetKind",
              "checkParameters"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "type": {
            "const": "integration.review"
          },
          "payload": {
            "type": "object",
            "properties": {
              "integrationId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "expectedRevision": {
                "type": "integer",
                "minimum": 1
              },
              "targetId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "runIds": {
                "type": "array",
                "minItems": 1,
                "maxItems": 16,
                "uniqueItems": true,
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                }
              },
              "decision": {
                "enum": [
                  "accept",
                  "reject"
                ]
              },
              "reason": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16384
              },
              "evidence": {
                "type": "array",
                "minItems": 1,
                "maxItems": 128,
                "items": {
                  "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ArtifactRef"
                }
              },
              "repairTaskId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "integrationId",
              "expectedRevision",
              "targetId",
              "runIds",
              "decision",
              "reason",
              "evidence"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "requestId",
          "projectId",
          "type",
          "payload"
        ],
        "additionalProperties": false
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/common.schema.json",
    "title": "ProjectOrch common.schema.json",
    "$defs": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "revision": {
        "type": "integer",
        "minimum": 0
      },
      "sessionRef": {
        "type": "object",
        "properties": {
          "harnessId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "hostId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "profileId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "nativeConversationId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          },
          "nativeWorkspaceId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          }
        },
        "required": [
          "harnessId",
          "hostId",
          "profileId",
          "nativeConversationId"
        ],
        "additionalProperties": false
      },
      "artifactRef": {
        "type": "object",
        "properties": {
          "artifactId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "version": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          }
        },
        "required": [
          "artifactId",
          "version"
        ],
        "additionalProperties": false
      },
      "time": {
        "type": "string",
        "format": "date-time"
      },
      "sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/domain.schema.json",
    "title": "领域详情与受控策略合同 v2",
    "$defs": {
      "ArtifactRef": {
        "type": "object",
        "properties": {
          "artifactId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "version": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          }
        },
        "required": [
          "artifactId",
          "version"
        ],
        "additionalProperties": false
      },
      "Dependency": {
        "type": "object",
        "properties": {
          "taskId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "requiredTaskRevision": {
            "type": "integer",
            "minimum": 0
          },
          "condition": {
            "type": "string",
            "enum": [
              "accepted",
              "artifact_available"
            ]
          },
          "outputName": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          }
        },
        "required": [
          "taskId",
          "requiredTaskRevision",
          "condition"
        ],
        "additionalProperties": false,
        "allOf": [
          {
            "if": {
              "properties": {
                "condition": {
                  "const": "artifact_available"
                }
              }
            },
            "then": {
              "required": [
                "outputName"
              ]
            }
          }
        ]
      },
      "AcceptanceRule": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "ruleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16384
              },
              "mode": {
                "const": "designated_reviewer"
              },
              "reviewerRoleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "independent": {
                "type": "boolean"
              }
            },
            "required": [
              "ruleId",
              "description",
              "mode",
              "reviewerRoleId",
              "independent"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "ruleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16384
              },
              "mode": {
                "const": "automated_check"
              },
              "checkDefinitionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "checkVersion": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "parameters": {
                "type": "object"
              }
            },
            "required": [
              "ruleId",
              "description",
              "mode",
              "checkDefinitionId",
              "checkVersion",
              "parameters"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "ruleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 16384
              },
              "mode": {
                "const": "user"
              }
            },
            "required": [
              "ruleId",
              "description",
              "mode"
            ],
            "additionalProperties": false
          }
        ]
      },
      "TaskSpec": {
        "type": "object",
        "properties": {
          "goal": {
            "type": "string",
            "minLength": 1,
            "maxLength": 16384
          },
          "inputArtifacts": {
            "type": "array",
            "items": {
              "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ArtifactRef"
            },
            "minItems": 0,
            "maxItems": 128
          },
          "outputRequirements": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "kind": {
                  "type": "string",
                  "enum": [
                    "file",
                    "report",
                    "git_commit"
                  ]
                },
                "description": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 16384
                }
              },
              "required": [
                "name",
                "kind",
                "description"
              ],
              "additionalProperties": false
            },
            "minItems": 1,
            "maxItems": 128
          },
          "acceptance": {
            "type": "array",
            "items": {
              "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/AcceptanceRule"
            },
            "minItems": 1,
            "maxItems": 32
          },
          "dependencies": {
            "type": "array",
            "items": {
              "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Dependency"
            },
            "minItems": 0,
            "maxItems": 128
          }
        },
        "required": [
          "goal",
          "inputArtifacts",
          "outputRequirements",
          "acceptance",
          "dependencies"
        ],
        "additionalProperties": false
      },
      "CheckDefinition": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "version": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "runner": {
            "type": "string",
            "enum": [
              "registered_process",
              "registered_validator"
            ]
          },
          "entryId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "entrySha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "parameterSchemaId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "timeoutMs": {
            "type": "integer",
            "minimum": 1,
            "maximum": 3600000
          },
          "permissions": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "minItems": 0,
            "maxItems": 128
          },
          "scopePaths": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2048
            },
            "minItems": 0,
            "maxItems": 128
          },
          "enabled": {
            "type": "boolean"
          }
        },
        "required": [
          "id",
          "version",
          "runner",
          "entryId",
          "entrySha256",
          "parameterSchemaId",
          "timeoutMs",
          "permissions",
          "scopePaths",
          "enabled"
        ],
        "additionalProperties": false
      },
      "PermissionProfile": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "revision": {
            "type": "integer",
            "minimum": 0
          },
          "actions": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "minItems": 0,
            "maxItems": 128
          },
          "readPaths": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2048
            },
            "minItems": 0,
            "maxItems": 128
          },
          "writePaths": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2048
            },
            "minItems": 0,
            "maxItems": 128
          },
          "roleIds": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "minItems": 0,
            "maxItems": 128
          },
          "delegableActions": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "minItems": 0,
            "maxItems": 128
          },
          "maxDelegationDepth": {
            "type": "integer",
            "minimum": 0,
            "maximum": 16
          }
        },
        "required": [
          "id",
          "revision",
          "actions",
          "readPaths",
          "writePaths",
          "roleIds",
          "delegableActions",
          "maxDelegationDepth"
        ],
        "additionalProperties": false
      },
      "ExecutionLimits": {
        "type": "object",
        "properties": {
          "totalConcurrency": {
            "type": "integer",
            "minimum": 1,
            "maximum": 64
          },
          "roleConcurrency": {
            "const": 1
          },
          "maxAttempts": {
            "type": "integer",
            "minimum": 1,
            "maximum": 32
          },
          "maxCorrectionTurns": {
            "type": "integer",
            "minimum": 0,
            "maximum": 5
          },
          "maxManagementRounds": {
            "type": "integer",
            "minimum": 1,
            "maximum": 16
          },
          "maxDynamicRoles": {
            "type": "integer",
            "minimum": 0,
            "maximum": 128
          },
          "wallTimeMs": {
            "type": "integer",
            "minimum": 1000
          },
          "costCeiling": {
            "type": [
              "number",
              "null"
            ],
            "minimum": 0
          },
          "costEnforcement": {
            "type": "string",
            "enum": [
              "unavailable",
              "advisory",
              "harness_enforced"
            ]
          }
        },
        "required": [
          "totalConcurrency",
          "roleConcurrency",
          "maxAttempts",
          "maxCorrectionTurns",
          "maxManagementRounds",
          "maxDynamicRoles",
          "wallTimeMs",
          "costCeiling",
          "costEnforcement"
        ],
        "additionalProperties": false
      },
      "Policy": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "revision": {
            "type": "integer",
            "minimum": 0
          },
          "profiles": {
            "type": "array",
            "items": {
              "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/PermissionProfile"
            },
            "minItems": 1,
            "maxItems": 128
          },
          "limits": {
            "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ExecutionLimits"
          },
          "nativeMode": {
            "type": "string",
            "enum": [
              "disabled",
              "verified_only"
            ]
          },
          "writeIsolation": {
            "type": "string",
            "enum": [
              "exclusive_workspace",
              "enforced_paths"
            ]
          }
        },
        "required": [
          "id",
          "revision",
          "profiles",
          "limits",
          "nativeMode",
          "writeIsolation"
        ],
        "additionalProperties": false
      },
      "EffectiveGrant": {
        "type": "object",
        "properties": {
          "policyRevision": {
            "type": "integer",
            "minimum": 0
          },
          "profileId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "profileRevision": {
            "type": "integer",
            "minimum": 0
          },
          "actions": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "minItems": 0,
            "maxItems": 128
          },
          "readPaths": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2048
            },
            "minItems": 0,
            "maxItems": 128
          },
          "writePaths": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2048
            },
            "minItems": 0,
            "maxItems": 128
          },
          "delegableActions": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "minItems": 0,
            "maxItems": 128
          },
          "remainingLimits": {
            "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ExecutionLimits"
          }
        },
        "required": [
          "policyRevision",
          "profileId",
          "profileRevision",
          "actions",
          "readPaths",
          "writePaths",
          "delegableActions",
          "remainingLimits"
        ],
        "additionalProperties": false
      },
      "WaitTarget": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "kind": {
                "const": "message"
              },
              "messageId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "kind",
              "messageId"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "const": "question"
              },
              "questionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "questionRevision": {
                "type": "integer",
                "minimum": 0
              }
            },
            "required": [
              "kind",
              "questionId",
              "questionRevision"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "const": "task"
              },
              "taskId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "taskRevision": {
                "type": "integer",
                "minimum": 0
              }
            },
            "required": [
              "kind",
              "taskId",
              "taskRevision"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "const": "external"
              },
              "conditionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "conditionRevision": {
                "type": "integer",
                "minimum": 0
              },
              "verifierRoleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "kind",
              "conditionId",
              "conditionRevision",
              "verifierRoleId"
            ],
            "additionalProperties": false
          }
        ]
      },
      "Wait": {
        "type": "object",
        "properties": {
          "target": {
            "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/WaitTarget"
          },
          "deadline": {
            "type": "string",
            "format": "date-time"
          },
          "onTimeout": {
            "type": "string",
            "enum": [
              "raise_issue",
              "cancel_attempt"
            ]
          },
          "taskRevision": {
            "type": "integer",
            "minimum": 0
          },
          "attemptId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "bindingEpoch": {
            "type": "integer",
            "minimum": 1
          }
        },
        "required": [
          "target",
          "deadline",
          "onTimeout",
          "taskRevision",
          "attemptId",
          "bindingEpoch"
        ],
        "additionalProperties": false
      },
      "Answerer": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "kind": {
                "const": "user"
              }
            },
            "required": [
              "kind"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "const": "role"
              },
              "roleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "kind",
              "roleId"
            ],
            "additionalProperties": false
          }
        ]
      },
      "Question": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "revision": {
            "type": "integer",
            "minimum": 0
          },
          "taskId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "taskRevision": {
            "type": "integer",
            "minimum": 0
          },
          "attemptId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "bindingEpoch": {
            "type": "integer",
            "minimum": 1
          },
          "prompt": {
            "type": "string",
            "minLength": 1,
            "maxLength": 16384
          },
          "answerer": {
            "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Answerer"
          },
          "deadline": {
            "type": "string",
            "format": "date-time"
          },
          "onTimeout": {
            "type": "string",
            "enum": [
              "raise_issue",
              "cancel_attempt"
            ]
          },
          "state": {
            "type": "string",
            "enum": [
              "open",
              "answered",
              "expired",
              "cancelled"
            ]
          },
          "answer": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "id",
          "projectId",
          "revision",
          "taskId",
          "taskRevision",
          "attemptId",
          "bindingEpoch",
          "prompt",
          "answerer",
          "deadline",
          "onTimeout",
          "state",
          "answer"
        ],
        "additionalProperties": false
      },
      "Attempt": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "taskId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "taskRevision": {
            "type": "integer",
            "minimum": 0
          },
          "bindingEpoch": {
            "type": "integer",
            "minimum": 1
          },
          "workspaceId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "state": {
            "type": "string",
            "enum": [
              "dispatching",
              "running",
              "waiting_input",
              "succeeded",
              "failed",
              "interrupted",
              "unknown"
            ]
          },
          "nativeExecutionId": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "id",
          "taskId",
          "taskRevision",
          "bindingEpoch",
          "workspaceId",
          "state",
          "nativeExecutionId"
        ],
        "additionalProperties": false
      },
      "TaskDetail": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "revision": {
            "type": "integer",
            "minimum": 0
          },
          "specRevision": {
            "type": "integer",
            "minimum": 0
          },
          "planRevision": {
            "type": "integer",
            "minimum": 0
          },
          "roleId": {
            "type": [
              "string",
              "null"
            ]
          },
          "state": {
            "type": "string",
            "enum": [
              "draft",
              "ready",
              "active",
              "waiting",
              "review",
              "accepted",
              "blocked",
              "cancelled"
            ]
          },
          "spec": {
            "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/TaskSpec"
          },
          "currentAttempt": {
            "anyOf": [
              {
                "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Attempt"
              },
              {
                "type": "null"
              }
            ]
          },
          "wait": {
            "anyOf": [
              {
                "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Wait"
              },
              {
                "type": "null"
              }
            ]
          },
          "resultIds": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "minItems": 0,
            "maxItems": 128
          },
          "integrationIds": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "minItems": 0,
            "maxItems": 128
          }
        },
        "required": [
          "id",
          "projectId",
          "revision",
          "specRevision",
          "planRevision",
          "roleId",
          "state",
          "spec",
          "currentAttempt",
          "wait",
          "resultIds",
          "integrationIds"
        ],
        "additionalProperties": false
      },
      "RoleDetail": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "revision": {
            "type": "integer",
            "minimum": 0
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          },
          "charter": {
            "type": "string",
            "minLength": 1,
            "maxLength": 16384
          },
          "parentRoleId": {
            "type": [
              "string",
              "null"
            ]
          },
          "scopePaths": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2048
            },
            "minItems": 0,
            "maxItems": 128
          },
          "effectiveGrant": {
            "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/EffectiveGrant"
          },
          "desiredState": {
            "type": "string",
            "enum": [
              "enabled",
              "paused",
              "disabled"
            ]
          },
          "bindingState": {
            "type": "string",
            "enum": [
              "unbound",
              "provisioning",
              "ready",
              "error"
            ]
          },
          "bindingEpoch": {
            "type": "integer",
            "minimum": 0
          },
          "sessionRef": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "harnessId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "hostId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "profileId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "nativeConversationId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 512
                  },
                  "nativeWorkspaceId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 512
                  }
                },
                "required": [
                  "harnessId",
                  "hostId",
                  "profileId",
                  "nativeConversationId"
                ],
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          },
          "observedState": {
            "type": "string",
            "enum": [
              "idle",
              "running",
              "waiting_approval",
              "offline",
              "unknown"
            ]
          },
          "observedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time"
          }
        },
        "required": [
          "id",
          "projectId",
          "revision",
          "name",
          "charter",
          "parentRoleId",
          "scopePaths",
          "effectiveGrant",
          "desiredState",
          "bindingState",
          "bindingEpoch",
          "sessionRef",
          "observedState",
          "observedAt"
        ],
        "additionalProperties": false
      },
      "ArtifactDetail": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "taskId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "version": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          },
          "kind": {
            "type": "string",
            "enum": [
              "file",
              "report",
              "git_commit"
            ]
          },
          "pathRef": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "sha256": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "commitId": {
            "type": [
              "string",
              "null"
            ]
          },
          "byteSize": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0
          },
          "readUrl": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "id",
          "projectId",
          "taskId",
          "version",
          "kind",
          "pathRef",
          "sha256",
          "commitId",
          "byteSize",
          "readUrl"
        ],
        "additionalProperties": false
      },
      "IssueDetail": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "revision": {
            "type": "integer",
            "minimum": 0
          },
          "taskId": {
            "type": [
              "string",
              "null"
            ]
          },
          "category": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "summary": {
            "type": "string",
            "minLength": 1,
            "maxLength": 16384
          },
          "ownerRoleId": {
            "type": [
              "string",
              "null"
            ]
          },
          "state": {
            "type": "string",
            "enum": [
              "open",
              "assigned",
              "deciding",
              "applying",
              "monitoring",
              "resolved",
              "escalated"
            ]
          },
          "evidence": {
            "type": "array",
            "items": {
              "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ArtifactRef"
            },
            "minItems": 0,
            "maxItems": 128
          },
          "triedActions": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 16384
            },
            "minItems": 0,
            "maxItems": 128
          },
          "resolution": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "id",
          "projectId",
          "revision",
          "taskId",
          "category",
          "summary",
          "ownerRoleId",
          "state",
          "evidence",
          "triedActions",
          "resolution"
        ],
        "additionalProperties": false
      },
      "Workspace": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "revision": {
            "type": "integer",
            "minimum": 0
          },
          "canonicalPath": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096
          },
          "kind": {
            "type": "string",
            "enum": [
              "git",
              "directory"
            ]
          },
          "ownerTaskId": {
            "type": [
              "string",
              "null"
            ]
          },
          "managed": {
            "type": "boolean"
          },
          "writePaths": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2048
            },
            "minItems": 0,
            "maxItems": 128
          },
          "enforcement": {
            "type": "string",
            "enum": [
              "enforced",
              "advisory",
              "unknown"
            ]
          },
          "state": {
            "type": "string",
            "enum": [
              "available",
              "reserved",
              "unknown",
              "retired"
            ]
          }
        },
        "required": [
          "id",
          "projectId",
          "revision",
          "canonicalPath",
          "kind",
          "ownerTaskId",
          "managed",
          "writePaths",
          "enforcement",
          "state"
        ],
        "additionalProperties": false
      },
      "Handover": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "roleId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "fromBindingEpoch": {
            "type": "integer",
            "minimum": 1
          },
          "revision": {
            "type": "integer",
            "minimum": 0
          },
          "planRevision": {
            "type": "integer",
            "minimum": 0
          },
          "artifact": {
            "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ArtifactRef"
          },
          "taskSpecRevisions": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "taskId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "specRevision": {
                  "type": "integer",
                  "minimum": 0
                }
              },
              "required": [
                "taskId",
                "specRevision"
              ],
              "additionalProperties": false
            },
            "minItems": 0,
            "maxItems": 128
          },
          "workspaceVersions": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "workspaceId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "contentHash": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                }
              },
              "required": [
                "workspaceId",
                "contentHash"
              ],
              "additionalProperties": false
            },
            "minItems": 0,
            "maxItems": 128
          },
          "unresolvedIssueIds": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "minItems": 0,
            "maxItems": 128
          },
          "pendingEffects": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "minItems": 0,
            "maxItems": 128
          },
          "verifierRoleId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "state": {
            "type": "string",
            "enum": [
              "prepared",
              "verified",
              "consumed",
              "stale"
            ]
          }
        },
        "required": [
          "id",
          "projectId",
          "roleId",
          "fromBindingEpoch",
          "revision",
          "planRevision",
          "artifact",
          "taskSpecRevisions",
          "workspaceVersions",
          "unresolvedIssueIds",
          "pendingEffects",
          "verifierRoleId",
          "state"
        ],
        "additionalProperties": false
      },
      "Integration": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "revision": {
            "type": "integer",
            "minimum": 0
          },
          "taskId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "targetWorkspaceId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "targetVersion": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          },
          "artifacts": {
            "type": "array",
            "items": {
              "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ArtifactRef"
            },
            "minItems": 1,
            "maxItems": 128
          },
          "checkRefs": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "version": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                }
              },
              "required": [
                "id",
                "version"
              ],
              "additionalProperties": false
            },
            "minItems": 1,
            "maxItems": 128
          },
          "state": {
            "type": "string",
            "enum": [
              "pending",
              "integrating",
              "verified",
              "failed"
            ]
          },
          "evidence": {
            "type": "array",
            "items": {
              "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ArtifactRef"
            },
            "minItems": 0,
            "maxItems": 128
          },
          "outputTarget": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "kind": {
                "enum": [
                  "files",
                  "git"
                ]
              },
              "outputVersion": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "contentHash": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "resultId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "contentPath": {
                "type": [
                  "string",
                  "null"
                ],
                "minLength": 1,
                "maxLength": 2048
              }
            },
            "required": [
              "id",
              "kind",
              "outputVersion",
              "contentHash",
              "resultId"
            ],
            "additionalProperties": false
          },
          "checkRuns": {
            "type": "array",
            "minItems": 1,
            "maxItems": 16,
            "items": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "checkId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "checkVersion": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "outcome": {
                  "enum": [
                    "passed",
                    "failed"
                  ]
                },
                "evidenceSha256": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                }
              },
              "required": [
                "id",
                "checkId",
                "checkVersion",
                "outcome",
                "evidenceSha256"
              ],
              "additionalProperties": false
            }
          },
          "review": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "decision": {
                "enum": [
                  "accept",
                  "reject"
                ]
              },
              "reviewerRoleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "repairTaskId": {
                "anyOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "targetChanged": {
                "type": "boolean"
              }
            },
            "required": [
              "id",
              "decision",
              "reviewerRoleId",
              "repairTaskId",
              "targetChanged"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "id",
          "projectId",
          "revision",
          "taskId",
          "targetWorkspaceId",
          "targetVersion",
          "artifacts",
          "checkRefs",
          "state",
          "evidence"
        ],
        "additionalProperties": false
      },
      "Receipt": {
        "type": "object",
        "properties": {
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": [
              "string",
              "null"
            ]
          },
          "commandId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "status": {
            "type": "string",
            "enum": [
              "stored",
              "queued",
              "applying",
              "completed",
              "uncertain",
              "failed"
            ]
          },
          "receiptUrl": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2048
          },
          "entityIds": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "localRef": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "entityType": {
                  "type": "string",
                  "enum": [
                    "project",
                    "role",
                    "task",
                    "attempt",
                    "message",
                    "artifact",
                    "case",
                    "question",
                    "workspace",
                    "handover",
                    "integration",
                    "policy",
                    "check",
                    "hold",
                    "result",
                    "binding"
                  ]
                },
                "id": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "revision": {
                  "type": "integer",
                  "minimum": 0
                },
                "version": {
                  "type": [
                    "string",
                    "null"
                  ]
                }
              },
              "required": [
                "localRef",
                "entityType",
                "id",
                "revision",
                "version"
              ],
              "additionalProperties": false
            },
            "minItems": 0,
            "maxItems": 128
          },
          "error": {
            "anyOf": [
              {
                "$ref": "https://projectorch.invalid/schemas/error.schema.json#/$defs/detail"
              },
              {
                "type": "null"
              }
            ]
          },
          "lastEventSequence": {
            "type": "integer",
            "minimum": 0
          }
        },
        "required": [
          "requestId",
          "projectId",
          "commandId",
          "status",
          "receiptUrl",
          "entityIds",
          "error",
          "lastEventSequence"
        ],
        "additionalProperties": false,
        "allOf": [
          {
            "if": {
              "properties": {
                "status": {
                  "const": "failed"
                }
              }
            },
            "then": {
              "properties": {
                "error": {
                  "$ref": "https://projectorch.invalid/schemas/error.schema.json#/$defs/detail"
                }
              }
            }
          }
        ]
      },
      "Source": {
        "type": "object",
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "authenticated_user",
              "role_forwarded",
              "native_unverified",
              "kernel"
            ]
          },
          "principalId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "originCommandId": {
            "type": [
              "string",
              "null"
            ]
          },
          "sessionRef": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "harnessId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "hostId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "profileId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  },
                  "nativeConversationId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 512
                  },
                  "nativeWorkspaceId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 512
                  }
                },
                "required": [
                  "harnessId",
                  "hostId",
                  "profileId",
                  "nativeConversationId"
                ],
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "kind",
          "principalId",
          "originCommandId",
          "sessionRef"
        ],
        "additionalProperties": false
      },
      "Overview": {
        "type": "object",
        "properties": {
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "planRevision": {
            "type": "integer",
            "minimum": 0
          },
          "acceptedTaskIds": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "minItems": 0,
            "maxItems": 128
          },
          "unintegratedArtifactIds": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "minItems": 0,
            "maxItems": 128
          },
          "blockers": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "issueId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "ownerRoleId": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "reason": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 16384
                }
              },
              "required": [
                "issueId",
                "ownerRoleId",
                "reason"
              ],
              "additionalProperties": false
            },
            "minItems": 0,
            "maxItems": 128
          },
          "nextTaskIds": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "minItems": 0,
            "maxItems": 128
          },
          "openQuestionIds": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "minItems": 0,
            "maxItems": 128
          },
          "dispatchHoldIds": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "minItems": 0,
            "maxItems": 128
          },
          "limits": {
            "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ExecutionLimits"
          },
          "observedAt": {
            "type": "string",
            "format": "date-time"
          }
        },
        "required": [
          "projectId",
          "planRevision",
          "acceptedTaskIds",
          "unintegratedArtifactIds",
          "blockers",
          "nextTaskIds",
          "openQuestionIds",
          "dispatchHoldIds",
          "limits",
          "observedAt"
        ],
        "additionalProperties": false
      },
      "Identity": {
        "type": "object",
        "properties": {
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "roleId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "bindingEpoch": {
            "type": "integer",
            "minimum": 1
          },
          "sessionRef": {
            "type": "object",
            "properties": {
              "harnessId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "hostId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "profileId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "nativeConversationId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512
              },
              "nativeWorkspaceId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512
              }
            },
            "required": [
              "harnessId",
              "hostId",
              "profileId",
              "nativeConversationId"
            ],
            "additionalProperties": false
          },
          "effectiveGrant": {
            "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/EffectiveGrant"
          },
          "protocolVersion": {
            "const": 2
          },
          "startupRequired": {
            "type": "boolean"
          }
        },
        "required": [
          "projectId",
          "roleId",
          "bindingEpoch",
          "sessionRef",
          "effectiveGrant",
          "protocolVersion",
          "startupRequired"
        ],
        "additionalProperties": false
      },
      "ResultDetail": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "taskId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "taskRevision": {
            "type": "integer",
            "minimum": 0
          },
          "attemptId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "outcome": {
            "type": "string",
            "enum": [
              "succeeded",
              "failed",
              "inconclusive"
            ]
          },
          "outputs": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "artifactId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "version": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 256
                },
                "outputName": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                }
              },
              "required": [
                "artifactId",
                "version",
                "outputName"
              ],
              "additionalProperties": false
            },
            "minItems": 0,
            "maxItems": 100
          },
          "checks": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "ruleId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "checkVersion": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "outcome": {
                  "type": "string",
                  "enum": [
                    "passed",
                    "failed",
                    "not_run"
                  ]
                },
                "evidence": {
                  "type": "array",
                  "items": {
                    "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ArtifactRef"
                  },
                  "minItems": 1,
                  "maxItems": 100
                }
              },
              "required": [
                "ruleId",
                "checkVersion",
                "outcome",
                "evidence"
              ],
              "additionalProperties": false
            },
            "minItems": 0,
            "maxItems": 100
          },
          "decisions": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "ruleId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "reviewerPrincipalId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "decision": {
                  "type": "string",
                  "enum": [
                    "accept",
                    "reject",
                    "needs_evidence"
                  ]
                },
                "evidence": {
                  "type": "array",
                  "items": {
                    "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/ArtifactRef"
                  },
                  "minItems": 0,
                  "maxItems": 100
                }
              },
              "required": [
                "ruleId",
                "reviewerPrincipalId",
                "decision",
                "evidence"
              ],
              "additionalProperties": false
            },
            "minItems": 0,
            "maxItems": 100
          },
          "eligibility": {
            "type": "string",
            "enum": [
              "current",
              "stale",
              "disputed"
            ]
          }
        },
        "required": [
          "id",
          "projectId",
          "taskId",
          "taskRevision",
          "attemptId",
          "outcome",
          "outputs",
          "checks",
          "decisions",
          "eligibility"
        ],
        "additionalProperties": false
      },
      "GoalHold": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "revision": {
            "type": "integer",
            "minimum": 0
          },
          "source": {
            "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Source"
          },
          "observedPlanRevision": {
            "type": "integer",
            "minimum": 0
          },
          "affectedTaskIds": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "minItems": 0,
            "maxItems": 100
          },
          "scopeKnown": {
            "type": "boolean"
          },
          "state": {
            "type": "string",
            "enum": [
              "pending",
              "resolved",
              "awaiting_user"
            ]
          },
          "reason": {
            "type": "string",
            "minLength": 1,
            "maxLength": 16384
          }
        },
        "required": [
          "id",
          "projectId",
          "revision",
          "source",
          "observedPlanRevision",
          "affectedTaskIds",
          "scopeKnown",
          "state",
          "reason"
        ],
        "additionalProperties": false
      },
      "MessageDetail": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "projectId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "toRoleId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "body": {
            "type": "string",
            "minLength": 1,
            "maxLength": 65536
          },
          "state": {
            "type": "string",
            "enum": [
              "stored",
              "queued",
              "sending",
              "delivered",
              "acknowledged",
              "resolved",
              "uncertain",
              "failed",
              "cancelled"
            ]
          },
          "source": {
            "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Source"
          },
          "replyToMessageId": {
            "type": [
              "string",
              "null"
            ]
          },
          "taskId": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "id",
          "projectId",
          "toRoleId",
          "body",
          "state",
          "source",
          "replyToMessageId",
          "taskId"
        ],
        "additionalProperties": false
      },
      "SessionDetail": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "sessionRef": {
            "type": "object",
            "properties": {
              "harnessId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "hostId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "profileId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "nativeConversationId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512
              },
              "nativeWorkspaceId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512
              }
            },
            "required": [
              "harnessId",
              "hostId",
              "profileId",
              "nativeConversationId"
            ],
            "additionalProperties": false
          },
          "observedState": {
            "type": "string",
            "enum": [
              "idle",
              "running",
              "waiting_approval",
              "offline",
              "unknown"
            ]
          },
          "attachState": {
            "type": "string",
            "enum": [
              "unknown",
              "verified",
              "unsupported"
            ]
          },
          "bindingRoleId": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "id",
          "sessionRef",
          "observedState",
          "attachState",
          "bindingRoleId"
        ],
        "additionalProperties": false
      },
      "ArtifactChunk": {
        "type": "object",
        "properties": {
          "artifactId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "version": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          },
          "offset": {
            "type": "integer",
            "minimum": 0
          },
          "content": {
            "type": "string",
            "minLength": 0,
            "maxLength": 65536
          },
          "encoding": {
            "type": "string",
            "enum": [
              "utf8",
              "base64"
            ],
            "description": "content的显式编码；offset/nextOffset按原始字节计算，sha256为完整原始内容哈希。"
          },
          "nextOffset": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0
          },
          "sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          }
        },
        "required": [
          "artifactId",
          "version",
          "offset",
          "content",
          "encoding",
          "nextOffset",
          "sha256"
        ],
        "additionalProperties": false
      },
      "IntegrationRunEvidence": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "integrationId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "targetId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "evidenceSha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "evidence": {
            "type": "object"
          },
          "target": {
            "type": "object"
          }
        },
        "required": [
          "id",
          "integrationId",
          "targetId",
          "evidenceSha256",
          "evidence",
          "target"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/error.schema.json",
    "title": "ProjectOrch error.schema.json",
    "type": "object",
    "properties": {
      "error": {
        "$ref": "#/$defs/detail"
      }
    },
    "required": [
      "error"
    ],
    "additionalProperties": false,
    "$defs": {
      "detail": {
        "type": "object",
        "properties": {
          "code": {
            "type": "string",
            "enum": [
              "UNAUTHENTICATED",
              "FORBIDDEN",
              "NOT_FOUND",
              "REVISION_CONFLICT",
              "IDEMPOTENCY_CONFLICT",
              "INVALID_STATE",
              "DEPENDENCY_CYCLE",
              "NATIVE_TARGET_CHANGED",
              "CAPABILITY_UNSUPPORTED",
              "ADAPTER_OFFLINE",
              "DELIVERY_UNCERTAIN",
              "BUDGET_EXCEEDED",
              "VALIDATION_ERROR",
              "INTERNAL_ERROR",
              "STALE_SPEC",
              "STALE_WAIT",
              "DISPATCH_HELD",
              "WORKSPACE_CONFLICT",
              "CHECK_UNAVAILABLE",
              "REVIEW_REQUIRED"
            ]
          },
          "message": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8192
          },
          "requestId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "retryable": {
            "type": "boolean"
          },
          "details": {
            "type": "object"
          }
        },
        "required": [
          "code",
          "message",
          "requestId",
          "retryable"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/event.schema.json",
    "title": "ProjectOrch event.schema.json",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "const": 2
      },
      "eventId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "sequence": {
        "type": "integer",
        "minimum": 1
      },
      "projectId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "occurredAt": {
        "type": "string",
        "format": "date-time"
      },
      "type": {
        "type": "string",
        "enum": [
          "role.changed",
          "binding.changed",
          "task.changed",
          "attempt.changed",
          "message.changed",
          "case.changed",
          "changeset.changed",
          "native.item.changed",
          "native.status.changed",
          "native.history.reset",
          "approval.changed",
          "capability.changed",
          "question.changed",
          "wait.changed",
          "goal.hold.changed",
          "workspace.changed",
          "handover.changed",
          "integration.changed",
          "guard.denied",
          "role.protocol.violation"
        ]
      },
      "entityId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "entityRevision": {
        "type": "integer",
        "minimum": 0
      },
      "causationId": {
        "type": [
          "string",
          "null"
        ]
      },
      "source": {
        "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Source"
      },
      "data": {
        "type": "object"
      }
    },
    "required": [
      "schemaVersion",
      "eventId",
      "sequence",
      "projectId",
      "occurredAt",
      "type",
      "entityId",
      "entityRevision",
      "causationId",
      "source",
      "data"
    ],
    "additionalProperties": false,
    "allOf": [
      {
        "if": {
          "properties": {
            "type": {
              "const": "question.changed"
            }
          }
        },
        "then": {
          "properties": {
            "data": {
              "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Question"
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "type": {
              "const": "goal.hold.changed"
            }
          }
        },
        "then": {
          "properties": {
            "data": {
              "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/GoalHold"
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "type": {
              "const": "workspace.changed"
            }
          }
        },
        "then": {
          "properties": {
            "data": {
              "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Workspace"
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "type": {
              "const": "handover.changed"
            }
          }
        },
        "then": {
          "properties": {
            "data": {
              "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Handover"
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "type": {
              "const": "integration.changed"
            }
          }
        },
        "then": {
          "properties": {
            "data": {
              "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Integration"
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "type": {
              "const": "wait.changed"
            }
          }
        },
        "then": {
          "properties": {
            "data": {
              "type": "object",
              "properties": {
                "waitId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 128
                },
                "wait": {
                  "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Wait"
                },
                "state": {
                  "enum": [
                    "waiting",
                    "resolved",
                    "expired",
                    "cancelled",
                    "stale"
                  ]
                }
              },
              "required": [
                "waitId",
                "wait",
                "state"
              ],
              "additionalProperties": false
            }
          }
        }
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/evidence.schema.json",
    "title": "ProjectOrch evidence.schema.json",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "const": 2
      },
      "evidenceId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "caseId": {
        "type": "string",
        "pattern": "^A[0-9]{3}$"
      },
      "status": {
        "type": "string",
        "enum": [
          "PASS",
          "FAIL",
          "BLOCKED",
          "NOT_RUN"
        ]
      },
      "kind": {
        "type": "string",
        "enum": [
          "unit",
          "integration",
          "native",
          "e2e",
          "security",
          "load",
          "release",
          "manual"
        ]
      },
      "recordedAt": {
        "type": "string",
        "format": "date-time"
      },
      "environment": {
        "type": "object",
        "properties": {
          "os": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256
          },
          "node": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "harnessVersions": {
            "type": "object",
            "additionalProperties": {
              "type": "object",
              "properties": {
                "client": {
                  "type": "string",
                  "minLength": 1
                },
                "backend": {
                  "type": "string",
                  "minLength": 1
                },
                "adapter": {
                  "type": "string",
                  "minLength": 1
                },
                "protocol": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "required": [
                "client",
                "backend",
                "adapter",
                "protocol"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "os",
          "node"
        ],
        "additionalProperties": false
      },
      "steps": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 8192
        },
        "minItems": 0,
        "maxItems": 128
      },
      "assertions": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 8192
        },
        "minItems": 0,
        "maxItems": 128
      },
      "files": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "minLength": 1
            },
            "sha256": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "kind": {
              "type": "string",
              "enum": [
                "raw_log",
                "native_event",
                "dual_end_observation",
                "artifact",
                "review",
                "timing",
                "other"
              ]
            }
          },
          "required": [
            "path",
            "sha256",
            "kind"
          ],
          "additionalProperties": false
        },
        "minItems": 0,
        "maxItems": 128
      },
      "nativeSessionRefs": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "harnessId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "hostId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "profileId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "nativeConversationId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 512
            },
            "nativeWorkspaceId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 512
            }
          },
          "required": [
            "harnessId",
            "hostId",
            "profileId",
            "nativeConversationId"
          ],
          "additionalProperties": false
        },
        "minItems": 0,
        "maxItems": 32
      },
      "notes": {
        "type": "string",
        "minLength": 1,
        "maxLength": 16384
      },
      "subject": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "applicationCommit": {
                "anyOf": [
                  {
                    "type": "string",
                    "pattern": "^([a-f0-9]{40}|[a-f0-9]{64})$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "sourceTreeSha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "contractVersion": {
                "const": 2
              },
              "targetPlatform": {
                "type": "string",
                "minLength": 1
              },
              "components": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1
                    },
                    "sha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    }
                  },
                  "required": [
                    "id",
                    "sha256"
                  ],
                  "additionalProperties": false
                },
                "minItems": 1,
                "maxItems": 128
              },
              "releaseArtifactHashes": {
                "type": "array",
                "items": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "minItems": 0,
                "maxItems": 128
              }
            },
            "required": [
              "applicationCommit",
              "sourceTreeSha256",
              "contractVersion",
              "targetPlatform",
              "components",
              "releaseArtifactHashes"
            ],
            "additionalProperties": false
          },
          {
            "type": "null"
          }
        ]
      },
      "executorId": {
        "anyOf": [
          {
            "type": "string",
            "minLength": 1
          },
          {
            "type": "null"
          }
        ]
      },
      "review": {
        "type": "object",
        "properties": {
          "status": {
            "type": "string",
            "enum": [
              "PENDING",
              "APPROVED",
              "CHANGES_REQUESTED"
            ]
          },
          "reviewerId": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1
              },
              {
                "type": "null"
              }
            ]
          },
          "report": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "path": {
                    "type": "string",
                    "minLength": 1
                  },
                  "sha256": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  }
                },
                "required": [
                  "path",
                  "sha256"
                ],
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          },
          "subjectSha256": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "status",
          "reviewerId",
          "report",
          "subjectSha256"
        ],
        "additionalProperties": false,
        "allOf": [
          {
            "if": {
              "properties": {
                "status": {
                  "const": "APPROVED"
                }
              }
            },
            "then": {
              "properties": {
                "reviewerId": {
                  "type": "string",
                  "minLength": 1
                },
                "report": {
                  "type": "object",
                  "properties": {
                    "path": {
                      "type": "string",
                      "minLength": 1
                    },
                    "sha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    }
                  },
                  "required": [
                    "path",
                    "sha256"
                  ],
                  "additionalProperties": false
                },
                "subjectSha256": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                }
              }
            }
          }
        ]
      },
      "applicability": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "candidateSourceTreeSha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "unchangedComponentIds": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1
                },
                "minItems": 1,
                "maxItems": 128
              },
              "impactReport": {
                "type": "object",
                "properties": {
                  "path": {
                    "type": "string",
                    "minLength": 1
                  },
                  "sha256": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  }
                },
                "required": [
                  "path",
                  "sha256"
                ],
                "additionalProperties": false
              },
              "reviewerId": {
                "type": "string",
                "minLength": 1
              }
            },
            "required": [
              "candidateSourceTreeSha256",
              "unchangedComponentIds",
              "impactReport",
              "reviewerId"
            ],
            "additionalProperties": false
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "required": [
      "schemaVersion",
      "evidenceId",
      "caseId",
      "status",
      "kind",
      "recordedAt",
      "environment",
      "steps",
      "assertions",
      "files",
      "nativeSessionRefs",
      "notes",
      "subject",
      "executorId",
      "review",
      "applicability"
    ],
    "additionalProperties": false,
    "allOf": [
      {
        "if": {
          "properties": {
            "status": {
              "const": "PASS"
            }
          }
        },
        "then": {
          "properties": {
            "subject": {
              "type": "object",
              "properties": {
                "applicationCommit": {
                  "anyOf": [
                    {
                      "type": "string",
                      "pattern": "^([a-f0-9]{40}|[a-f0-9]{64})$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "sourceTreeSha256": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "contractVersion": {
                  "const": 2
                },
                "targetPlatform": {
                  "type": "string",
                  "minLength": 1
                },
                "components": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "id": {
                        "type": "string",
                        "minLength": 1
                      },
                      "sha256": {
                        "type": "string",
                        "pattern": "^[a-f0-9]{64}$"
                      }
                    },
                    "required": [
                      "id",
                      "sha256"
                    ],
                    "additionalProperties": false
                  },
                  "minItems": 1,
                  "maxItems": 128
                },
                "releaseArtifactHashes": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "minItems": 0,
                  "maxItems": 128
                }
              },
              "required": [
                "applicationCommit",
                "sourceTreeSha256",
                "contractVersion",
                "targetPlatform",
                "components",
                "releaseArtifactHashes"
              ],
              "additionalProperties": false
            },
            "executorId": {
              "type": "string",
              "minLength": 1
            },
            "steps": {
              "minItems": 1
            },
            "assertions": {
              "minItems": 1
            },
            "review": {
              "properties": {
                "status": {
                  "const": "APPROVED"
                }
              }
            },
            "files": {
              "minItems": 1
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "kind": {
              "const": "native"
            },
            "status": {
              "const": "PASS"
            }
          }
        },
        "then": {
          "properties": {
            "environment": {
              "required": [
                "harnessVersions"
              ],
              "properties": {
                "harnessVersions": {
                  "minProperties": 1
                }
              }
            },
            "nativeSessionRefs": {
              "minItems": 1
            },
            "files": {
              "contains": {
                "properties": {
                  "kind": {
                    "enum": [
                      "native_event",
                      "dual_end_observation"
                    ]
                  }
                },
                "required": [
                  "kind"
                ]
              }
            }
          }
        }
      },
      {
        "if": {
          "properties": {
            "kind": {
              "const": "release"
            },
            "status": {
              "const": "PASS"
            }
          }
        },
        "then": {
          "properties": {
            "subject": {
              "properties": {
                "releaseArtifactHashes": {
                  "minItems": 1
                }
              }
            },
            "files": {
              "contains": {
                "properties": {
                  "kind": {
                    "const": "artifact"
                  }
                },
                "required": [
                  "kind"
                ]
              }
            }
          }
        }
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/feasibility.schema.json",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "const": 2
      },
      "harnessId": {
        "type": "string",
        "enum": [
          "codex",
          "zcode"
        ]
      },
      "status": {
        "type": "string",
        "enum": [
          "NOT_STARTED",
          "INVESTIGATING",
          "CONCLUDED"
        ]
      },
      "conclusion": {
        "type": "string",
        "enum": [
          "UNKNOWN",
          "FEASIBLE",
          "INFEASIBLE",
          "INCONCLUSIVE"
        ]
      },
      "ownerId": {
        "anyOf": [
          {
            "type": "string",
            "minLength": 1
          },
          {
            "type": "null"
          }
        ]
      },
      "investigationBudget": {
        "type": "object",
        "properties": {
          "maxRoutes": {
            "const": 3
          },
          "maxHours": {
            "type": "number",
            "minimum": 1,
            "maximum": 40
          }
        },
        "required": [
          "maxRoutes",
          "maxHours"
        ],
        "additionalProperties": false
      },
      "routes": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "supported_entry",
                "supported_extension",
                "maintained_bridge"
              ]
            },
            "status": {
              "type": "string",
              "enum": [
                "NOT_TRIED",
                "SUPPORTED",
                "FAILED",
                "BLOCKED"
              ]
            },
            "evidenceFiles": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "path": {
                    "type": "string",
                    "minLength": 1
                  },
                  "sha256": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  }
                },
                "required": [
                  "path",
                  "sha256"
                ],
                "additionalProperties": false
              },
              "minItems": 0,
              "maxItems": 128
            },
            "reason": {
              "type": "string",
              "minLength": 1
            },
            "maintenanceCost": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "kind",
            "status",
            "evidenceFiles",
            "reason",
            "maintenanceCost"
          ],
          "additionalProperties": false
        },
        "minItems": 0,
        "maxItems": 3
      },
      "dimensions": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": {
              "type": "string",
              "enum": [
                "backend_entry",
                "existing_session_tools",
                "trusted_identity",
                "dual_end_race",
                "recovery",
                "bridge_distribution"
              ]
            },
            "conclusion": {
              "type": "string",
              "enum": [
                "UNKNOWN",
                "SUPPORTED",
                "UNSUPPORTED",
                "BLOCKED"
              ]
            },
            "evidenceFiles": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "path": {
                    "type": "string",
                    "minLength": 1
                  },
                  "sha256": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  }
                },
                "required": [
                  "path",
                  "sha256"
                ],
                "additionalProperties": false
              },
              "minItems": 0,
              "maxItems": 128
            },
            "reason": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "name",
            "conclusion",
            "evidenceFiles",
            "reason"
          ],
          "additionalProperties": false
        },
        "minItems": 6,
        "maxItems": 128
      },
      "decisionReport": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "minLength": 1
              },
              "sha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              }
            },
            "required": [
              "path",
              "sha256"
            ],
            "additionalProperties": false
          },
          {
            "type": "null"
          }
        ]
      },
      "review": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "reviewerId": {
                "type": "string",
                "minLength": 1
              },
              "decision": {
                "const": "APPROVED"
              },
              "report": {
                "type": "object",
                "properties": {
                  "path": {
                    "type": "string",
                    "minLength": 1
                  },
                  "sha256": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  }
                },
                "required": [
                  "path",
                  "sha256"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "reviewerId",
              "decision",
              "report"
            ],
            "additionalProperties": false
          },
          {
            "type": "null"
          }
        ]
      },
      "nextAction": {
        "type": "string",
        "minLength": 1
      }
    },
    "required": [
      "schemaVersion",
      "harnessId",
      "status",
      "conclusion",
      "ownerId",
      "investigationBudget",
      "routes",
      "dimensions",
      "decisionReport",
      "review",
      "nextAction"
    ],
    "additionalProperties": false,
    "allOf": [
      {
        "if": {
          "properties": {
            "status": {
              "const": "CONCLUDED"
            }
          }
        },
        "then": {
          "properties": {
            "conclusion": {
              "type": "string",
              "enum": [
                "FEASIBLE",
                "INFEASIBLE",
                "INCONCLUSIVE"
              ]
            },
            "ownerId": {
              "type": "string",
              "minLength": 1
            },
            "decisionReport": {
              "type": "object",
              "properties": {
                "path": {
                  "type": "string",
                  "minLength": 1
                },
                "sha256": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                }
              },
              "required": [
                "path",
                "sha256"
              ],
              "additionalProperties": false
            },
            "review": {
              "type": "object"
            }
          },
          "required": [
            "decisionReport",
            "review"
          ]
        }
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/message.schema.json",
    "title": "ProjectOrch message.schema.json",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "const": 2
      },
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "projectId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "toRoleId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "kind": {
        "type": "string",
        "enum": [
          "information",
          "question",
          "answer",
          "task_request",
          "result_notice",
          "correction",
          "control_request"
        ]
      },
      "body": {
        "type": "string",
        "minLength": 1,
        "maxLength": 65536
      },
      "taskId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "replyToMessageId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "artifacts": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "artifactId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "version": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            }
          },
          "required": [
            "artifactId",
            "version"
          ],
          "additionalProperties": false
        },
        "minItems": 0,
        "maxItems": 64
      },
      "delivery": {
        "type": "object",
        "properties": {
          "mode": {
            "type": "string",
            "enum": [
              "inbox",
              "when_available",
              "steer_current",
              "interrupt_then_deliver"
            ]
          },
          "priority": {
            "type": "string",
            "enum": [
              "normal",
              "urgent"
            ]
          },
          "expectedExecutionId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          },
          "expectedBindingEpoch": {
            "type": "integer",
            "minimum": 1
          },
          "expiresAt": {
            "type": "string",
            "format": "date-time"
          }
        },
        "required": [
          "mode",
          "priority"
        ],
        "additionalProperties": false,
        "allOf": [
          {
            "if": {
              "properties": {
                "mode": {
                  "enum": [
                    "steer_current",
                    "interrupt_then_deliver"
                  ]
                }
              },
              "required": [
                "mode"
              ]
            },
            "then": {
              "required": [
                "expectedExecutionId",
                "expectedBindingEpoch"
              ]
            }
          }
        ]
      }
    },
    "required": [
      "schemaVersion",
      "requestId",
      "projectId",
      "toRoleId",
      "kind",
      "body",
      "delivery"
    ],
    "additionalProperties": false,
    "allOf": [
      {
        "if": {
          "properties": {
            "kind": {
              "const": "answer"
            }
          },
          "required": [
            "kind"
          ]
        },
        "then": {
          "required": [
            "replyToMessageId"
          ]
        }
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/pairing.schema.json",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "const": 2
      },
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "oneTimeCode": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "challengeId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "required": [
      "schemaVersion",
      "requestId",
      "oneTimeCode",
      "challengeId"
    ],
    "additionalProperties": false
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/project-create.schema.json",
    "title": "ProjectOrch project-create.schema.json",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "const": 2
      },
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "hostId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "rootPath": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "objective": {
        "type": "string",
        "minLength": 1,
        "maxLength": 16384
      },
      "initialPolicy": {
        "$ref": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Policy"
      }
    },
    "required": [
      "schemaVersion",
      "requestId",
      "name",
      "hostId",
      "rootPath",
      "objective",
      "initialPolicy"
    ],
    "additionalProperties": false
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/query.schema.json",
    "oneOf": [
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "identity"
          },
          "payload": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "task.read"
          },
          "payload": {
            "type": "object",
            "properties": {
              "taskId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "taskId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "task.list"
          },
          "payload": {
            "type": "object",
            "properties": {
              "projectId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "cursor": {
                "type": "string"
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100
              }
            },
            "required": [
              "projectId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "role.read"
          },
          "payload": {
            "type": "object",
            "properties": {
              "roleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "roleId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "role.list"
          },
          "payload": {
            "type": "object",
            "properties": {
              "projectId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "cursor": {
                "type": "string"
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100
              }
            },
            "required": [
              "projectId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "result.read"
          },
          "payload": {
            "type": "object",
            "properties": {
              "resultId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "resultId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "artifact.read"
          },
          "payload": {
            "type": "object",
            "properties": {
              "artifactId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "artifactId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "artifact.content"
          },
          "payload": {
            "type": "object",
            "properties": {
              "artifactId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "version": {
                "type": "string",
                "minLength": 1,
                "maxLength": 256
              },
              "offset": {
                "type": "integer",
                "minimum": 0
              }
            },
            "required": [
              "artifactId",
              "version",
              "offset"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "issue.read"
          },
          "payload": {
            "type": "object",
            "properties": {
              "caseId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "caseId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "issue.list"
          },
          "payload": {
            "type": "object",
            "properties": {
              "projectId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "cursor": {
                "type": "string"
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100
              }
            },
            "required": [
              "projectId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "question.read"
          },
          "payload": {
            "type": "object",
            "properties": {
              "questionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "questionId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "question.list"
          },
          "payload": {
            "type": "object",
            "properties": {
              "projectId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "cursor": {
                "type": "string"
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100
              }
            },
            "required": [
              "projectId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "policy.read"
          },
          "payload": {
            "type": "object",
            "properties": {
              "projectId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "projectId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "check.read"
          },
          "payload": {
            "type": "object",
            "properties": {
              "checkId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "version": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "checkId",
              "version"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "workspace.read"
          },
          "payload": {
            "type": "object",
            "properties": {
              "workspaceId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "workspaceId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "workspace.list"
          },
          "payload": {
            "type": "object",
            "properties": {
              "projectId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "cursor": {
                "type": "string"
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100
              }
            },
            "required": [
              "projectId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "handover.read"
          },
          "payload": {
            "type": "object",
            "properties": {
              "handoverId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "handoverId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "integration.read"
          },
          "payload": {
            "type": "object",
            "properties": {
              "integrationId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "integrationId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "goal.hold.read"
          },
          "payload": {
            "type": "object",
            "properties": {
              "holdId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "holdId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "project.overview"
          },
          "payload": {
            "type": "object",
            "properties": {
              "projectId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "projectId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "session.list"
          },
          "payload": {
            "type": "object",
            "properties": {
              "projectId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "cursor": {
                "type": "string"
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100
              }
            },
            "required": [
              "projectId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "project.list"
          },
          "payload": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "project.snapshot"
          },
          "payload": {
            "type": "object",
            "properties": {
              "projectId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "projectId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "session.history"
          },
          "payload": {
            "type": "object",
            "properties": {
              "sessionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "cursor": {
                "type": "string"
              }
            },
            "required": [
              "sessionId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "receipt.read"
          },
          "payload": {
            "type": "object",
            "properties": {
              "requestId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "requestId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "inbox.read"
          },
          "payload": {
            "type": "object",
            "properties": {
              "roleId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "cursor": {
                "type": "string"
              },
              "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100
              }
            },
            "required": [
              "roleId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "capability.list"
          },
          "payload": {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "events.subscribe"
          },
          "payload": {
            "type": "object",
            "properties": {
              "projectId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "Last-Event-ID": {
                "type": "string"
              }
            },
            "required": [
              "projectId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      },
      {
        "type": "object",
        "properties": {
          "schemaVersion": {
            "const": 2
          },
          "type": {
            "const": "integration.run.read"
          },
          "payload": {
            "type": "object",
            "properties": {
              "integrationId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "runId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "integrationId",
              "runId"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "schemaVersion",
          "type",
          "payload"
        ],
        "additionalProperties": false
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/result.schema.json",
    "title": "ProjectOrch result.schema.json",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "const": 2
      },
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "projectId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "taskId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "taskRevision": {
        "type": "integer",
        "minimum": 0
      },
      "attemptId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "bindingEpoch": {
        "type": "integer",
        "minimum": 1
      },
      "outcome": {
        "type": "string",
        "enum": [
          "succeeded",
          "failed",
          "inconclusive"
        ]
      },
      "summary": {
        "type": "string",
        "minLength": 1,
        "maxLength": 16384
      },
      "outputs": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "artifactId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "version": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "outputName": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            }
          },
          "required": [
            "artifactId",
            "version",
            "outputName"
          ],
          "additionalProperties": false
        },
        "minItems": 0,
        "maxItems": 128
      },
      "checks": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": {
              "type": "string",
              "minLength": 1,
              "maxLength": 256
            },
            "outcome": {
              "type": "string",
              "enum": [
                "passed",
                "failed",
                "not_run"
              ]
            },
            "evidenceArtifactId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            }
          },
          "required": [
            "name",
            "outcome",
            "evidenceArtifactId"
          ],
          "additionalProperties": false
        },
        "minItems": 0,
        "maxItems": 128
      },
      "remainingIssues": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 4096
        },
        "minItems": 0,
        "maxItems": 128
      }
    },
    "required": [
      "schemaVersion",
      "requestId",
      "projectId",
      "taskId",
      "taskRevision",
      "attemptId",
      "bindingEpoch",
      "outcome",
      "summary",
      "outputs",
      "checks",
      "remainingIssues"
    ],
    "additionalProperties": false,
    "allOf": [
      {
        "if": {
          "properties": {
            "outcome": {
              "const": "succeeded"
            }
          },
          "required": [
            "outcome"
          ]
        },
        "then": {
          "properties": {
            "outputs": {
              "minItems": 1
            }
          }
        }
      }
    ]
  },
  {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://projectorch.invalid/schemas/task-readiness.schema.json",
    "title": "ProjectOrch任务依赖与规格待重核快照",
    "type": "object",
    "properties": {
      "schemaVersion": {
        "const": 2
      },
      "taskId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "projectId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "revision": {
        "type": "integer",
        "minimum": 0
      },
      "specRevision": {
        "type": "integer",
        "minimum": 0
      },
      "planRevision": {
        "type": "integer",
        "minimum": 0
      },
      "userPaused": {
        "type": "boolean"
      },
      "dependencyReady": {
        "type": "boolean"
      },
      "blocks": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "taskId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "requiredRevision": {
              "type": "integer",
              "minimum": 0
            },
            "currentRevision": {
              "type": [
                "integer",
                "null"
              ],
              "minimum": 0
            },
            "reason": {
              "enum": [
                "TASK_SPEC_REVALIDATION_REQUIRED",
                "PREREQ_NOT_FOUND",
                "PREREQ_SPEC_MISMATCH",
                "PREREQ_CANCELLED",
                "PREREQ_NOT_ACCEPTED",
                "PREREQ_OUTPUT_NAME_MISSING",
                "PREREQ_NO_ARTIFACT",
                "PREREQ_CONDITION_UNSUPPORTED"
              ]
            }
          },
          "required": [
            "taskId",
            "requiredRevision",
            "currentRevision",
            "reason"
          ],
          "additionalProperties": false
        }
      },
      "unresolvedAttempts": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "attemptId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "specRevision": {
              "type": "integer",
              "minimum": 0
            },
            "state": {
              "enum": [
                "dispatching",
                "running",
                "waiting_input",
                "unknown"
              ]
            }
          },
          "required": [
            "attemptId",
            "specRevision",
            "state"
          ],
          "additionalProperties": false
        }
      }
    },
    "required": [
      "schemaVersion",
      "taskId",
      "projectId",
      "revision",
      "specRevision",
      "planRevision",
      "userPaused",
      "dependencyReady",
      "blocks",
      "unresolvedAttempts"
    ],
    "additionalProperties": false
  }
];
export const schemaIds = {
  "approval": "https://projectorch.invalid/schemas/approval.schema.json",
  "artifact-chunk": "https://projectorch.invalid/schemas/artifact-chunk.schema.json",
  "capabilities": "https://projectorch.invalid/schemas/capabilities.schema.json",
  "changeset": "https://projectorch.invalid/schemas/changeset.schema.json",
  "command": "https://projectorch.invalid/schemas/command.schema.json",
  "error": "https://projectorch.invalid/schemas/error.schema.json",
  "event": "https://projectorch.invalid/schemas/event.schema.json",
  "evidence": "https://projectorch.invalid/schemas/evidence.schema.json",
  "feasibility": "https://projectorch.invalid/schemas/feasibility.schema.json",
  "message": "https://projectorch.invalid/schemas/message.schema.json",
  "pairing": "https://projectorch.invalid/schemas/pairing.schema.json",
  "project-create": "https://projectorch.invalid/schemas/project-create.schema.json",
  "query": "https://projectorch.invalid/schemas/query.schema.json",
  "result": "https://projectorch.invalid/schemas/result.schema.json",
  "task-readiness": "https://projectorch.invalid/schemas/task-readiness.schema.json",
  "receipt": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Receipt",
  "policy": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Policy",
  "task-detail": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/TaskDetail",
  "task-spec": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/TaskSpec",
  "question": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Question",
  "handover": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Handover",
  "integration": "https://projectorch.invalid/schemas/domain.schema.json#/$defs/Integration"
} as const;
