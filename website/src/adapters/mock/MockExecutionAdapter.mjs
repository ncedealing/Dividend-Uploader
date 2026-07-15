export class MockExecutionAdapter {
  constructor({ platform = "mt5" } = {}) {
    this.platform = platform;
    this.adjustments = [];
  }

  async applyBalanceAdjustment(request) {
    this.adjustments.push(request);
    return {
      success: true,
      platform: request.platform ?? this.platform,
      managerReturnCode: 0,
      managerOperationId: `mock-${request.idempotencyKey}`,
      rawMessage: "mock execution adapter accepted local test adjustment",
      appliedAt: new Date().toISOString(),
    };
  }
}
