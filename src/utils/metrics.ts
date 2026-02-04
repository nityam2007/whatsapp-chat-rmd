/**
 * Pipeline Metrics Module
 * 
 * Tracks performance metrics for the event extraction pipeline including:
 * - Message processing rates
 * - LLM usage and skip rates
 * - Processing latencies
 * - Error rates
 * 
 * Designed for monitoring and optimization of the simple extraction system.
 */

import logger from './logger.js';

/**
 * Metrics data structure
 */
export interface PipelineMetrics {
  // Counters
  messagesProcessed: number;
  messagesDroppedByHeuristic: number;
  messagesPassedHeuristic: number;
  ruleEngineExtractions: number;
  llmExtractions: number;
  llmSkipped: number;
  eventsCreated: number;
  eventsUpdated: number;
  errors: number;
  
  // Timing (in milliseconds)
  avgHeuristicLatency: number;
  avgRuleEngineLatency: number;
  avgLlmLatency: number;
  avgTotalLatency: number;
  
  // Derived rates
  heuristicDropRate: number;
  ruleEngineHitRate: number;
  llmSkipRate: number;
  errorRate: number;
  
  // Time tracking
  startTime: Date;
  lastUpdated: Date;
}

/**
 * Individual timing record
 */
interface TimingRecord {
  heuristic: number;
  ruleEngine: number;
  llm: number;
  total: number;
}

/**
 * Metrics collector class
 * Thread-safe singleton for collecting pipeline metrics
 */
class MetricsCollector {
  private static instance: MetricsCollector;
  
  // Counters
  private messagesProcessed = 0;
  private messagesDroppedByHeuristic = 0;
  private messagesPassedHeuristic = 0;
  private ruleEngineExtractions = 0;
  private llmExtractions = 0;
  private llmSkipped = 0;
  private eventsCreated = 0;
  private eventsUpdated = 0;
  private errors = 0;
  
  // Timing storage (ring buffer for last 1000 measurements)
  private readonly TIMING_BUFFER_SIZE = 1000;
  private timings: TimingRecord[] = [];
  private timingIndex = 0;
  
  // Timestamps
  private startTime: Date;
  private lastUpdated: Date;
  
  private constructor() {
    this.startTime = new Date();
    this.lastUpdated = new Date();
  }
  
  /**
   * Get the singleton instance
   */
  static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }
  
  /**
   * Record a message being processed
   */
  recordMessageProcessed(): void {
    this.messagesProcessed++;
    this.lastUpdated = new Date();
  }
  
  /**
   * Record a message dropped by heuristic gate
   */
  recordHeuristicDrop(): void {
    this.messagesDroppedByHeuristic++;
    this.lastUpdated = new Date();
  }
  
  /**
   * Record a message passing heuristic gate
   */
  recordHeuristicPass(): void {
    this.messagesPassedHeuristic++;
    this.lastUpdated = new Date();
  }

  /**
   * Record a successful rule engine extraction (legacy compatibility)
   */
  recordRuleEngineExtraction(): void {
    this.ruleEngineExtractions++;
    this.llmSkipped++;
    this.lastUpdated = new Date();
  }
  
  /**
   * Record an LLM extraction
   */
  recordLlmExtraction(): void {
    this.llmExtractions++;
    this.lastUpdated = new Date();
  }
  
  /**
   * Record an event creation
   */
  recordEventCreated(): void {
    this.eventsCreated++;
    this.lastUpdated = new Date();
  }
  
  /**
   * Record an event update
   */
  recordEventUpdated(): void {
    this.eventsUpdated++;
    this.lastUpdated = new Date();
  }
  
  /**
   * Record an error
   */
  recordError(): void {
    this.errors++;
    this.lastUpdated = new Date();
  }
  
  /**
   * Record timing for a pipeline execution
   */
  recordTiming(timing: Partial<TimingRecord>): void {
    const record: TimingRecord = {
      heuristic: timing.heuristic ?? 0,
      ruleEngine: timing.ruleEngine ?? 0,
      llm: timing.llm ?? 0,
      total: timing.total ?? 0,
    };
    
    // Ring buffer implementation
    if (this.timings.length < this.TIMING_BUFFER_SIZE) {
      this.timings.push(record);
    } else {
      this.timings[this.timingIndex] = record;
      this.timingIndex = (this.timingIndex + 1) % this.TIMING_BUFFER_SIZE;
    }
    
    this.lastUpdated = new Date();
  }
  
  /**
   * Calculate average from timing records
   */
  private calculateAverage(getter: (t: TimingRecord) => number): number {
    if (this.timings.length === 0) return 0;
    
    const sum = this.timings.reduce((acc, t) => acc + getter(t), 0);
    return Math.round((sum / this.timings.length) * 100) / 100;
  }
  
  /**
   * Get all metrics
   */
  getMetrics(): PipelineMetrics {
    const totalMessages = this.messagesProcessed || 1; // Avoid division by zero
    const passedHeuristic = this.messagesPassedHeuristic || 1;
    
    return {
      // Counters
      messagesProcessed: this.messagesProcessed,
      messagesDroppedByHeuristic: this.messagesDroppedByHeuristic,
      messagesPassedHeuristic: this.messagesPassedHeuristic,
      ruleEngineExtractions: this.ruleEngineExtractions,
      llmExtractions: this.llmExtractions,
      llmSkipped: this.llmSkipped,
      eventsCreated: this.eventsCreated,
      eventsUpdated: this.eventsUpdated,
      errors: this.errors,
      
      // Timing
      avgHeuristicLatency: this.calculateAverage(t => t.heuristic),
      avgRuleEngineLatency: this.calculateAverage(t => t.ruleEngine),
      avgLlmLatency: this.calculateAverage(t => t.llm),
      avgTotalLatency: this.calculateAverage(t => t.total),
      
      // Rates
      heuristicDropRate: Math.round((this.messagesDroppedByHeuristic / totalMessages) * 100) / 100,
      ruleEngineHitRate: Math.round((this.ruleEngineExtractions / passedHeuristic) * 100) / 100,
      llmSkipRate: Math.round((this.llmSkipped / passedHeuristic) * 100) / 100,
      errorRate: Math.round((this.errors / totalMessages) * 100) / 100,
      
      // Time tracking
      startTime: this.startTime,
      lastUpdated: this.lastUpdated,
    };
  }
  
  /**
   * Get a summary of key metrics for logging
   */
  getSummary(): Record<string, number | string> {
    const metrics = this.getMetrics();
    const uptime = Date.now() - this.startTime.getTime();
    const uptimeHours = Math.round((uptime / (1000 * 60 * 60)) * 10) / 10;
    
    return {
      uptimeHours,
      messagesProcessed: metrics.messagesProcessed,
      heuristicDropRate: `${Math.round(metrics.heuristicDropRate * 100)}%`,
      ruleEngineHitRate: `${Math.round(metrics.ruleEngineHitRate * 100)}%`,
      llmSkipRate: `${Math.round(metrics.llmSkipRate * 100)}%`,
      errorRate: `${Math.round(metrics.errorRate * 100)}%`,
      avgLatencyMs: metrics.avgTotalLatency,
      eventsCreated: metrics.eventsCreated,
      errors: metrics.errors,
    };
  }
  
  /**
   * Reset all metrics (useful for testing)
   */
  reset(): void {
    this.messagesProcessed = 0;
    this.messagesDroppedByHeuristic = 0;
    this.messagesPassedHeuristic = 0;
    this.ruleEngineExtractions = 0;
    this.llmExtractions = 0;
    this.llmSkipped = 0;
    this.eventsCreated = 0;
    this.eventsUpdated = 0;
    this.errors = 0;
    this.timings = [];
    this.timingIndex = 0;
    this.startTime = new Date();
    this.lastUpdated = new Date();
    
    logger.info('Metrics reset');
  }
  
  /**
   * Log current metrics summary
   */
  logSummary(): void {
    logger.info('Pipeline metrics summary', this.getSummary());
  }
}

// Export singleton instance
export const metrics = MetricsCollector.getInstance();

/**
 * Timer utility for measuring operation durations
 */
export class Timer {
  private startTime: number;
  private marks: Map<string, number> = new Map();
  
  constructor() {
    this.startTime = performance.now();
  }
  
  /**
   * Mark a checkpoint
   */
  mark(name: string): void {
    this.marks.set(name, performance.now());
  }
  
  /**
   * Get duration since start in milliseconds
   */
  elapsed(): number {
    return Math.round((performance.now() - this.startTime) * 100) / 100;
  }
  
  /**
   * Get duration between two marks (or from start if only one mark)
   */
  duration(from: string, to?: string): number {
    const fromTime = this.marks.get(from) ?? this.startTime;
    const toTime = to ? this.marks.get(to) ?? performance.now() : performance.now();
    return Math.round((toTime - fromTime) * 100) / 100;
  }
  
  /**
   * Get all timing data as an object
   */
  getAllTimings(): Record<string, number> {
    const result: Record<string, number> = {
      total: this.elapsed(),
    };
    
    let prevTime = this.startTime;
    const sortedMarks = [...this.marks.entries()].sort((a, b) => a[1] - b[1]);
    
    for (const [name, time] of sortedMarks) {
      result[name] = Math.round((time - prevTime) * 100) / 100;
      prevTime = time;
    }
    
    return result;
  }
}

/**
 * Create a new timer instance
 */
export function createTimer(): Timer {
  return new Timer();
}

export default metrics;
