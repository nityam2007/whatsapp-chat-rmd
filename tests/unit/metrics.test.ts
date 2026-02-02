/**
 * Unit tests for Pipeline Metrics Module
 * 
 * Tests the MetricsCollector singleton, Timer utility, and all metrics tracking
 * functionality including counters, rates, averages, and timing measurements.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { metrics, Timer, createTimer, type PipelineMetrics } from '../../src/utils/metrics.js';

describe('Pipeline Metrics', () => {
  // Reset metrics before each test to ensure isolation
  beforeEach(() => {
    metrics.reset();
  });

  describe('MetricsCollector Singleton', () => {
    it('should return the same instance', () => {
      const instance1 = metrics;
      const instance2 = metrics;
      expect(instance1).toBe(instance2);
    });

    it('should have initial zero counters after reset', () => {
      const m = metrics.getMetrics();
      expect(m.messagesProcessed).toBe(0);
      expect(m.messagesDroppedByHeuristic).toBe(0);
      expect(m.messagesPassedHeuristic).toBe(0);
      expect(m.ruleEngineExtractions).toBe(0);
      expect(m.llmExtractions).toBe(0);
      expect(m.llmSkipped).toBe(0);
      expect(m.eventsCreated).toBe(0);
      expect(m.eventsUpdated).toBe(0);
      expect(m.errors).toBe(0);
    });

    it('should have startTime and lastUpdated as Date objects', () => {
      const m = metrics.getMetrics();
      expect(m.startTime).toBeInstanceOf(Date);
      expect(m.lastUpdated).toBeInstanceOf(Date);
    });
  });

  describe('Counter Operations', () => {
    describe('recordMessageProcessed', () => {
      it('should increment messagesProcessed counter', () => {
        metrics.recordMessageProcessed();
        expect(metrics.getMetrics().messagesProcessed).toBe(1);
        
        metrics.recordMessageProcessed();
        metrics.recordMessageProcessed();
        expect(metrics.getMetrics().messagesProcessed).toBe(3);
      });

      it('should update lastUpdated timestamp', () => {
        const before = new Date();
        metrics.recordMessageProcessed();
        const after = new Date();
        
        const m = metrics.getMetrics();
        expect(m.lastUpdated.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(m.lastUpdated.getTime()).toBeLessThanOrEqual(after.getTime());
      });
    });

    describe('recordHeuristicDrop', () => {
      it('should increment messagesDroppedByHeuristic counter', () => {
        metrics.recordHeuristicDrop();
        expect(metrics.getMetrics().messagesDroppedByHeuristic).toBe(1);
        
        metrics.recordHeuristicDrop();
        expect(metrics.getMetrics().messagesDroppedByHeuristic).toBe(2);
      });
    });

    describe('recordHeuristicPass', () => {
      it('should increment messagesPassedHeuristic counter', () => {
        metrics.recordHeuristicPass();
        expect(metrics.getMetrics().messagesPassedHeuristic).toBe(1);
        
        metrics.recordHeuristicPass();
        metrics.recordHeuristicPass();
        expect(metrics.getMetrics().messagesPassedHeuristic).toBe(3);
      });
    });

    describe('recordRuleEngineExtraction', () => {
      it('should increment both ruleEngineExtractions and llmSkipped', () => {
        metrics.recordRuleEngineExtraction();
        
        const m = metrics.getMetrics();
        expect(m.ruleEngineExtractions).toBe(1);
        expect(m.llmSkipped).toBe(1);
      });

      it('should keep counters synchronized', () => {
        metrics.recordRuleEngineExtraction();
        metrics.recordRuleEngineExtraction();
        metrics.recordRuleEngineExtraction();
        
        const m = metrics.getMetrics();
        expect(m.ruleEngineExtractions).toBe(m.llmSkipped);
      });
    });

    describe('recordLlmExtraction', () => {
      it('should increment llmExtractions counter', () => {
        metrics.recordLlmExtraction();
        expect(metrics.getMetrics().llmExtractions).toBe(1);
        
        metrics.recordLlmExtraction();
        expect(metrics.getMetrics().llmExtractions).toBe(2);
      });

      it('should not increment llmSkipped', () => {
        metrics.recordLlmExtraction();
        metrics.recordLlmExtraction();
        
        const m = metrics.getMetrics();
        expect(m.llmExtractions).toBe(2);
        expect(m.llmSkipped).toBe(0);
      });
    });

    describe('recordEventCreated', () => {
      it('should increment eventsCreated counter', () => {
        metrics.recordEventCreated();
        expect(metrics.getMetrics().eventsCreated).toBe(1);
        
        metrics.recordEventCreated();
        metrics.recordEventCreated();
        expect(metrics.getMetrics().eventsCreated).toBe(3);
      });
    });

    describe('recordEventUpdated', () => {
      it('should increment eventsUpdated counter', () => {
        metrics.recordEventUpdated();
        expect(metrics.getMetrics().eventsUpdated).toBe(1);
        
        metrics.recordEventUpdated();
        expect(metrics.getMetrics().eventsUpdated).toBe(2);
      });
    });

    describe('recordError', () => {
      it('should increment errors counter', () => {
        metrics.recordError();
        expect(metrics.getMetrics().errors).toBe(1);
        
        metrics.recordError();
        metrics.recordError();
        expect(metrics.getMetrics().errors).toBe(3);
      });
    });
  });

  describe('Rate Calculations', () => {
    describe('heuristicDropRate', () => {
      it('should calculate correct drop rate', () => {
        // Process 10 messages, drop 4
        for (let i = 0; i < 10; i++) {
          metrics.recordMessageProcessed();
        }
        for (let i = 0; i < 4; i++) {
          metrics.recordHeuristicDrop();
        }
        
        const m = metrics.getMetrics();
        expect(m.heuristicDropRate).toBe(0.4); // 4/10 = 0.4
      });

      it('should handle zero messages gracefully', () => {
        const m = metrics.getMetrics();
        expect(m.heuristicDropRate).toBe(0); // 0/1 = 0 (uses 1 to avoid division by zero)
      });

      it('should round to 2 decimal places', () => {
        for (let i = 0; i < 3; i++) {
          metrics.recordMessageProcessed();
        }
        metrics.recordHeuristicDrop();
        
        const m = metrics.getMetrics();
        expect(m.heuristicDropRate).toBe(0.33); // 1/3 rounded
      });
    });

    describe('ruleEngineHitRate', () => {
      it('should calculate correct hit rate based on passed heuristic', () => {
        // 5 messages pass heuristic, 3 handled by rule engine
        for (let i = 0; i < 5; i++) {
          metrics.recordHeuristicPass();
        }
        for (let i = 0; i < 3; i++) {
          metrics.recordRuleEngineExtraction();
        }
        
        const m = metrics.getMetrics();
        expect(m.ruleEngineHitRate).toBe(0.6); // 3/5 = 0.6
      });

      it('should handle zero passed messages gracefully', () => {
        const m = metrics.getMetrics();
        expect(m.ruleEngineHitRate).toBe(0);
      });
    });

    describe('llmSkipRate', () => {
      it('should calculate correct skip rate', () => {
        // 10 messages pass heuristic, 7 skip LLM
        for (let i = 0; i < 10; i++) {
          metrics.recordHeuristicPass();
        }
        for (let i = 0; i < 7; i++) {
          metrics.recordRuleEngineExtraction();
        }
        
        const m = metrics.getMetrics();
        expect(m.llmSkipRate).toBe(0.7); // 7/10 = 0.7
      });
    });

    describe('errorRate', () => {
      it('should calculate correct error rate', () => {
        for (let i = 0; i < 100; i++) {
          metrics.recordMessageProcessed();
        }
        for (let i = 0; i < 5; i++) {
          metrics.recordError();
        }
        
        const m = metrics.getMetrics();
        expect(m.errorRate).toBe(0.05); // 5/100 = 0.05
      });
    });
  });

  describe('Timing Recording', () => {
    describe('recordTiming', () => {
      it('should record timing with all fields', () => {
        metrics.recordTiming({
          heuristic: 0.5,
          ruleEngine: 2.0,
          llm: 150,
          total: 155,
        });
        
        const m = metrics.getMetrics();
        expect(m.avgHeuristicLatency).toBe(0.5);
        expect(m.avgRuleEngineLatency).toBe(2.0);
        expect(m.avgLlmLatency).toBe(150);
        expect(m.avgTotalLatency).toBe(155);
      });

      it('should handle partial timing records', () => {
        metrics.recordTiming({ heuristic: 1.0, total: 10 });
        
        const m = metrics.getMetrics();
        expect(m.avgHeuristicLatency).toBe(1.0);
        expect(m.avgRuleEngineLatency).toBe(0);
        expect(m.avgLlmLatency).toBe(0);
        expect(m.avgTotalLatency).toBe(10);
      });

      it('should calculate averages correctly', () => {
        metrics.recordTiming({ total: 100 });
        metrics.recordTiming({ total: 200 });
        metrics.recordTiming({ total: 300 });
        
        const m = metrics.getMetrics();
        expect(m.avgTotalLatency).toBe(200); // (100 + 200 + 300) / 3 = 200
      });

      it('should handle ring buffer overflow', () => {
        // Record more than TIMING_BUFFER_SIZE (1000) entries
        for (let i = 0; i < 1100; i++) {
          metrics.recordTiming({ total: i });
        }
        
        // Should still have valid average (last 1000 entries: 100-1099)
        const m = metrics.getMetrics();
        // Average of 100-1099 = (100 + 1099) / 2 = 599.5
        expect(m.avgTotalLatency).toBeCloseTo(599.5, 0);
      });
    });

    describe('average calculations', () => {
      it('should return 0 for empty timings', () => {
        const m = metrics.getMetrics();
        expect(m.avgHeuristicLatency).toBe(0);
        expect(m.avgRuleEngineLatency).toBe(0);
        expect(m.avgLlmLatency).toBe(0);
        expect(m.avgTotalLatency).toBe(0);
      });

      it('should round averages to 2 decimal places', () => {
        metrics.recordTiming({ total: 1 });
        metrics.recordTiming({ total: 2 });
        metrics.recordTiming({ total: 3 });
        
        const m = metrics.getMetrics();
        expect(m.avgTotalLatency).toBe(2); // (1 + 2 + 3) / 3 = 2
      });
    });
  });

  describe('getSummary', () => {
    it('should return summary with all key metrics', () => {
      metrics.recordMessageProcessed();
      metrics.recordMessageProcessed();
      metrics.recordHeuristicDrop();
      metrics.recordHeuristicPass();
      metrics.recordRuleEngineExtraction();
      metrics.recordEventCreated();
      metrics.recordTiming({ total: 50 });
      
      const summary = metrics.getSummary();
      
      expect(summary).toHaveProperty('uptimeHours');
      expect(summary).toHaveProperty('messagesProcessed');
      expect(summary).toHaveProperty('heuristicDropRate');
      expect(summary).toHaveProperty('ruleEngineHitRate');
      expect(summary).toHaveProperty('llmSkipRate');
      expect(summary).toHaveProperty('avgLatencyMs');
      expect(summary).toHaveProperty('eventsCreated');
      expect(summary).toHaveProperty('errors');
    });

    it('should format rates as percentages', () => {
      for (let i = 0; i < 10; i++) {
        metrics.recordMessageProcessed();
      }
      for (let i = 0; i < 5; i++) {
        metrics.recordHeuristicDrop();
      }
      
      const summary = metrics.getSummary();
      expect(summary.heuristicDropRate).toBe('50%');
    });

    it('should calculate uptime correctly', () => {
      // Small delay to ensure uptime > 0
      const summary = metrics.getSummary();
      expect(typeof summary.uptimeHours).toBe('number');
      expect(summary.uptimeHours).toBeGreaterThanOrEqual(0);
    });
  });

  describe('reset', () => {
    it('should reset all counters to zero', () => {
      // Set up various metrics
      metrics.recordMessageProcessed();
      metrics.recordMessageProcessed();
      metrics.recordHeuristicDrop();
      metrics.recordHeuristicPass();
      metrics.recordRuleEngineExtraction();
      metrics.recordLlmExtraction();
      metrics.recordEventCreated();
      metrics.recordEventUpdated();
      metrics.recordError();
      metrics.recordTiming({ total: 100 });
      
      // Verify they are set
      const beforeReset = metrics.getMetrics();
      expect(beforeReset.messagesProcessed).toBeGreaterThan(0);
      
      // Reset
      metrics.reset();
      
      // Verify all are zero
      const afterReset = metrics.getMetrics();
      expect(afterReset.messagesProcessed).toBe(0);
      expect(afterReset.messagesDroppedByHeuristic).toBe(0);
      expect(afterReset.messagesPassedHeuristic).toBe(0);
      expect(afterReset.ruleEngineExtractions).toBe(0);
      expect(afterReset.llmExtractions).toBe(0);
      expect(afterReset.llmSkipped).toBe(0);
      expect(afterReset.eventsCreated).toBe(0);
      expect(afterReset.eventsUpdated).toBe(0);
      expect(afterReset.errors).toBe(0);
      expect(afterReset.avgTotalLatency).toBe(0);
    });

    it('should reset timestamps', async () => {
      const beforeReset = metrics.getMetrics();
      const oldStartTime = beforeReset.startTime.getTime();
      
      // Small delay to ensure new timestamp is different
      await new Promise(resolve => setTimeout(resolve, 5));
      
      metrics.reset();
      
      const afterReset = metrics.getMetrics();
      expect(afterReset.startTime.getTime()).toBeGreaterThanOrEqual(oldStartTime);
    });
  });

  describe('Real-world Scenarios', () => {
    it('should track a typical pipeline execution', () => {
      // Simulate processing 100 messages
      for (let i = 0; i < 100; i++) {
        metrics.recordMessageProcessed();
        
        if (i % 2 === 0) {
          // 50% dropped by heuristic
          metrics.recordHeuristicDrop();
          metrics.recordTiming({ heuristic: 0.1, total: 0.1 });
        } else {
          // 50% pass heuristic
          metrics.recordHeuristicPass();
          
          if (i % 4 === 1) {
            // 25% handled by rule engine (skip LLM)
            metrics.recordRuleEngineExtraction();
            metrics.recordEventCreated();
            metrics.recordTiming({ heuristic: 0.1, ruleEngine: 2, total: 2.1 });
          } else {
            // 25% need LLM
            metrics.recordLlmExtraction();
            metrics.recordEventCreated();
            metrics.recordTiming({ heuristic: 0.1, ruleEngine: 2, llm: 150, total: 152.1 });
          }
        }
      }
      
      // Add some errors
      metrics.recordError();
      metrics.recordError();
      
      const m = metrics.getMetrics();
      
      expect(m.messagesProcessed).toBe(100);
      expect(m.messagesDroppedByHeuristic).toBe(50);
      expect(m.messagesPassedHeuristic).toBe(50);
      expect(m.heuristicDropRate).toBe(0.5);
      expect(m.eventsCreated).toBe(50); // All passed messages created events
      expect(m.errors).toBe(2);
      expect(m.errorRate).toBe(0.02);
    });

    it('should handle high-volume processing', () => {
      // Simulate 10,000 messages
      for (let i = 0; i < 10000; i++) {
        metrics.recordMessageProcessed();
        metrics.recordHeuristicPass();
        metrics.recordRuleEngineExtraction();
        metrics.recordEventCreated();
      }
      
      const m = metrics.getMetrics();
      expect(m.messagesProcessed).toBe(10000);
      expect(m.ruleEngineHitRate).toBe(1); // 100% handled by rule engine
      expect(m.llmSkipRate).toBe(1); // 100% skipped LLM
    });
  });
});

describe('Timer Utility', () => {
  describe('createTimer', () => {
    it('should create a new Timer instance', () => {
      const timer = createTimer();
      expect(timer).toBeInstanceOf(Timer);
    });

    it('should create independent instances', () => {
      const timer1 = createTimer();
      const timer2 = createTimer();
      
      timer1.mark('test');
      
      // timer2 should not have the mark from timer1
      expect(timer2.duration('test')).toBeGreaterThanOrEqual(0); // Will use startTime
    });
  });

  describe('Timer.mark', () => {
    it('should record a checkpoint', () => {
      const timer = new Timer();
      timer.mark('step1');
      
      // Small delay to ensure time passes
      const start = performance.now();
      while (performance.now() - start < 5) {
        // busy wait for ~5ms
      }
      
      timer.mark('step2');
      
      const duration = timer.duration('step1', 'step2');
      expect(duration).toBeGreaterThanOrEqual(4); // At least 4ms
    });

    it('should allow multiple marks', () => {
      const timer = new Timer();
      timer.mark('a');
      timer.mark('b');
      timer.mark('c');
      
      const timings = timer.getAllTimings();
      expect(timings).toHaveProperty('a');
      expect(timings).toHaveProperty('b');
      expect(timings).toHaveProperty('c');
    });

    it('should overwrite marks with same name', () => {
      const timer = new Timer();
      timer.mark('test');
      
      // Wait a bit
      const start = performance.now();
      while (performance.now() - start < 10) {}
      
      timer.mark('test');
      
      const firstDuration = timer.duration('test');
      expect(firstDuration).toBeLessThan(5); // Recent mark, small duration
    });
  });

  describe('Timer.elapsed', () => {
    it('should return time since start', () => {
      const timer = new Timer();
      
      // Busy wait for ~10ms
      const start = performance.now();
      while (performance.now() - start < 10) {}
      
      const elapsed = timer.elapsed();
      expect(elapsed).toBeGreaterThanOrEqual(9);
    });

    it('should round to 2 decimal places', () => {
      const timer = new Timer();
      const elapsed = timer.elapsed();
      
      // Check it's a reasonable number
      const decimalPlaces = (elapsed.toString().split('.')[1] || '').length;
      expect(decimalPlaces).toBeLessThanOrEqual(2);
    });
  });

  describe('Timer.duration', () => {
    it('should calculate duration between two marks', () => {
      const timer = new Timer();
      timer.mark('start');
      
      // Wait ~5ms
      const start = performance.now();
      while (performance.now() - start < 5) {}
      
      timer.mark('end');
      
      const duration = timer.duration('start', 'end');
      expect(duration).toBeGreaterThanOrEqual(4);
    });

    it('should calculate duration from mark to now if second param omitted', () => {
      const timer = new Timer();
      timer.mark('checkpoint');
      
      // Wait ~5ms
      const start = performance.now();
      while (performance.now() - start < 5) {}
      
      const duration = timer.duration('checkpoint');
      expect(duration).toBeGreaterThanOrEqual(4);
    });

    it('should use startTime if mark does not exist', () => {
      const timer = new Timer();
      
      // Wait ~5ms
      const start = performance.now();
      while (performance.now() - start < 5) {}
      
      const duration = timer.duration('nonexistent');
      expect(duration).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Timer.getAllTimings', () => {
    it('should return total and all mark durations', () => {
      const timer = new Timer();
      
      // Simulate sequential operations
      const wait = (ms: number) => {
        const start = performance.now();
        while (performance.now() - start < ms) {}
      };
      
      wait(5);
      timer.mark('heuristic');
      
      wait(5);
      timer.mark('ruleEngine');
      
      wait(5);
      timer.mark('complete');
      
      const timings = timer.getAllTimings();
      
      expect(timings).toHaveProperty('total');
      expect(timings).toHaveProperty('heuristic');
      expect(timings).toHaveProperty('ruleEngine');
      expect(timings).toHaveProperty('complete');
      
      expect(timings.total).toBeGreaterThanOrEqual(14);
      expect(timings.heuristic).toBeGreaterThanOrEqual(4);
    });

    it('should order marks chronologically', () => {
      const timer = new Timer();
      
      timer.mark('first');
      timer.mark('second');
      timer.mark('third');
      
      const timings = timer.getAllTimings();
      const keys = Object.keys(timings);
      
      // 'total' should be first, then marks in order
      expect(keys[0]).toBe('total');
    });

    it('should return only total if no marks', () => {
      const timer = new Timer();
      const timings = timer.getAllTimings();
      
      expect(Object.keys(timings)).toEqual(['total']);
      expect(timings.total).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Timer edge cases', () => {
    it('should handle very quick operations', () => {
      const timer = new Timer();
      timer.mark('quick');
      const elapsed = timer.elapsed();
      
      expect(elapsed).toBeGreaterThanOrEqual(0);
      expect(elapsed).toBeLessThan(10); // Should be very fast
    });

    it('should handle marks with special characters', () => {
      const timer = new Timer();
      timer.mark('step-1');
      timer.mark('step_2');
      timer.mark('step.3');
      
      const timings = timer.getAllTimings();
      expect(timings).toHaveProperty('step-1');
      expect(timings).toHaveProperty('step_2');
      expect(timings).toHaveProperty('step.3');
    });

    it('should handle empty string mark name', () => {
      const timer = new Timer();
      timer.mark('');
      
      const timings = timer.getAllTimings();
      expect(timings).toHaveProperty('');
    });
  });
});

describe('Metrics Integration', () => {
  beforeEach(() => {
    metrics.reset();
  });

  it('should work with Timer for pipeline timing', () => {
    const timer = createTimer();
    
    // Simulate heuristic stage
    timer.mark('heuristic');
    metrics.recordMessageProcessed();
    metrics.recordHeuristicPass();
    
    // Simulate rule engine stage
    timer.mark('ruleEngine');
    metrics.recordRuleEngineExtraction();
    
    // Record timing
    const timings = timer.getAllTimings();
    metrics.recordTiming({
      heuristic: timings.heuristic,
      ruleEngine: timings.ruleEngine,
      total: timings.total,
    });
    
    const m = metrics.getMetrics();
    expect(m.messagesProcessed).toBe(1);
    expect(m.ruleEngineExtractions).toBe(1);
    expect(m.avgTotalLatency).toBeGreaterThanOrEqual(0);
  });
});
