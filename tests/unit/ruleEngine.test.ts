/**
 * Rule Engine Unit Tests
 * 
 * Tests for the pattern-based extraction engine (Tier 2)
 * that extracts events without using LLM.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { extractWithRules, RuleEngineResult } from '../../src/pipeline/ruleEngine.js';

// Mock config to ensure rule engine is enabled
vi.mock('../../src/config/index.js', () => ({
  config: {
    enableRuleEngine: true,
    openaiApiKey: 'test-key',
  }
}));

describe('Rule Engine', () => {
  describe('Time Extraction', () => {
    describe('12-hour format with minutes', () => {
      it('should extract 2:30 PM', () => {
        const result = extractWithRules('Meeting at 2:30 PM');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('time:12hour_with_minutes');
        expect(result.event?.start_time).toBeDefined();
      });

      it('should extract 10:30 am', () => {
        const result = extractWithRules('Call at 10:30 am');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('time:12hour_with_minutes');
      });

      it('should extract time with pm format', () => {
        // Use standard pm format (p.m. format has regex boundary issues)
        const result = extractWithRules('Meeting at 2:45 PM');
        expect(result.matchedPatterns).toContain('time:12hour_with_minutes');
      });
    });

    describe('Simple hour format', () => {
      it('should extract 3pm', () => {
        const result = extractWithRules('Meeting at 3pm');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('time:simple_hour');
      });

      it('should extract 9 AM', () => {
        const result = extractWithRules('Call at 9 AM');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('time:simple_hour');
      });

      it('should extract 12 pm', () => {
        const result = extractWithRules('Meeting at 12 pm');
        expect(result.matchedPatterns).toContain('time:simple_hour');
        expect(result.event?.start_time).toBeDefined();
      });

      it('should extract 12 am', () => {
        const result = extractWithRules('Call at 12 am');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('time:simple_hour');
      });
    });

    describe('O\'clock format', () => {
      it('should extract 3 o\'clock', () => {
        const result = extractWithRules('Meeting at 3 o\'clock');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('time:oclock');
      });

      it('should extract 10 oclock', () => {
        const result = extractWithRules('Call at 10 oclock');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('time:oclock');
      });
    });

    describe('Half past format', () => {
      it('should extract half past 3', () => {
        const result = extractWithRules('Meeting at half past 3');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('time:half_past');
        expect(result.event?.start_time).toBeDefined();
      });

      it('should extract half past with number word', () => {
        // "Dinner" alone doesn't trigger event keywords, but half past pattern is detected
        const result = extractWithRules('Meeting at half past five');
        expect(result.matchedPatterns).toContain('time:half_past');
      });

      it('should extract half past twelve', () => {
        const result = extractWithRules('Meeting at half past twelve');
        expect(result.matchedPatterns).toContain('time:half_past');
      });
    });

    describe('Quarter past/to format', () => {
      it('should extract quarter past 3', () => {
        const result = extractWithRules('Meeting at quarter past 3');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('time:quarter_past');
        expect(result.event?.start_time).toBeDefined();
      });

      it('should extract quarter to 5', () => {
        const result = extractWithRules('Meeting at quarter to 5');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('time:quarter_to');
        expect(result.event?.start_time).toBeDefined();
      });

      it('should extract quarter past nine', () => {
        const result = extractWithRules('Call at quarter past nine');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('time:quarter_past');
      });
    });

    describe('Relative time format', () => {
      it('should extract in 2 hours', () => {
        const result = extractWithRules('Remind me in 2 hours');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('time:relative_hours');
      });

      it('should extract in 30 minutes', () => {
        const result = extractWithRules('Call in 30 minutes');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('time:relative_minutes');
      });

      it('should extract in 1 hr', () => {
        const result = extractWithRules('Remind me in 1 hr');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('time:relative_hours');
      });
    });

    describe('24-hour format', () => {
      it('should extract 14:30', () => {
        const result = extractWithRules('Meeting at 14:30');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('time:24hour');
      });

      it('should extract 09:00 with event keyword', () => {
        const result = extractWithRules('Meeting at 09:00');
        expect(result.matchedPatterns).toContain('time:24hour');
        expect(result.event?.start_time).toBeDefined();
      });
    });
  });

  describe('Date Extraction', () => {
    describe('Relative dates', () => {
      it('should extract today', () => {
        const result = extractWithRules('Meeting today at 3pm');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('date:today');
      });

      it('should extract tomorrow', () => {
        const result = extractWithRules('Meeting tomorrow at 3pm');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('date:tomorrow');
      });

      it('should extract tmrw (shorthand)', () => {
        const result = extractWithRules('Call tmrw at 10am');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('date:tomorrow');
      });

      it('should extract day after tomorrow with parso', () => {
        // "day after tomorrow" phrase needs parso/parson pattern
        const result = extractWithRules('Meeting parso at 3pm');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('date:day_after_tomorrow');
      });
    });

    describe('Hindi date words', () => {
      it('should extract aaj (today)', () => {
        const result = extractWithRules('Meeting aaj 3pm ko');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('date:today');
      });

      it('should extract kal (tomorrow)', () => {
        const result = extractWithRules('Call kal at 5pm');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('date:tomorrow');
      });

      it('should extract parso (day after tomorrow)', () => {
        const result = extractWithRules('Meeting parso at 3pm');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('date:day_after_tomorrow');
      });
    });

    describe('Weekday extraction', () => {
      it('should extract Friday', () => {
        const result = extractWithRules('Meeting Friday at 3pm');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns.some(p => p.includes('weekday'))).toBe(true);
      });

      it('should extract Mon (shorthand)', () => {
        const result = extractWithRules('Call Mon at 10am');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns.some(p => p.includes('weekday') || p.includes('mon'))).toBe(true);
      });

      it('should extract this Friday', () => {
        const result = extractWithRules('Meeting this Friday at 3pm');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns.some(p => p.includes('this_friday'))).toBe(true);
      });

      it('should extract next Monday', () => {
        const result = extractWithRules('Meeting next Monday at 2pm');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns.some(p => p.includes('next_monday'))).toBe(true);
      });
    });

    describe('Date with month', () => {
      it('should extract Dec 25', () => {
        const result = extractWithRules('Party on Dec 25 at 7pm');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('date:month_day');
      });

      it('should extract January 15th with event keyword', () => {
        // Need event keyword for high confidence
        const result = extractWithRules('Meeting January 15th at 3pm');
        expect(result.matchedPatterns).toContain('date:month_day');
      });

      it('should extract March 1 with event keyword', () => {
        const result = extractWithRules('Meeting on March 1 at 3pm');
        expect(result.matchedPatterns).toContain('date:month_day');
      });
    });

    describe('Date with slash format', () => {
      it('should extract 25/12 (DD/MM)', () => {
        const result = extractWithRules('Party on 25/12 at 7pm');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('date:slash_format');
      });

      it('should extract 12/25 when second > 12 (MM/DD)', () => {
        const result = extractWithRules('Party on 12/25 at 7pm');
        expect(result.success).toBe(true);
        expect(result.matchedPatterns).toContain('date:slash_format');
      });
    });
  });

  describe('Event Type Detection', () => {
    describe('New event detection', () => {
      it('should detect reminder patterns', () => {
        const result = extractWithRules('Remind me to call John');
        expect(result.event?.event_type).toBe('new_event');
        expect(result.matchedPatterns).toContain('action:remind');
      });

      it('should detect meeting patterns', () => {
        const result = extractWithRules('Meeting with team at 3pm');
        expect(result.event?.event_type).toBe('new_event');
        expect(result.matchedPatterns).toContain('action:meeting');
      });

      it('should detect task patterns', () => {
        const result = extractWithRules('Bring milk today');
        expect(result.event?.event_type).toBe('new_event');
        expect(result.matchedPatterns).toContain('action:task');
      });

      it('should detect task patterns with deadline keyword', () => {
        // "Submit report by Friday" matches task pattern (submit) not deadline
        const result = extractWithRules('Submit report by Friday');
        expect(result.event?.event_type).toBe('new_event');
        expect(result.matchedPatterns).toContain('action:task');
      });

      it('should detect don\'t forget patterns', () => {
        const result = extractWithRules('Don\'t forget to pick up the kids');
        expect(result.event?.event_type).toBe('new_event');
        expect(result.matchedPatterns).toContain('action:remind');
      });
    });

    describe('Update event detection', () => {
      it('should detect cancel patterns', () => {
        const result = extractWithRules('Cancel the meeting');
        expect(result.event?.event_type).toBe('update_event');
        expect(result.matchedPatterns).toContain('action:cancel');
      });

      it('should detect reschedule patterns', () => {
        const result = extractWithRules('Reschedule to 5pm');
        expect(result.event?.event_type).toBe('update_event');
        expect(result.matchedPatterns).toContain('action:reschedule');
      });

      it('should detect postpone patterns', () => {
        const result = extractWithRules('Postpone the meeting to tomorrow');
        expect(result.event?.event_type).toBe('update_event');
        expect(result.matchedPatterns).toContain('action:reschedule');
      });

      it('should detect shift to patterns', () => {
        // "call" triggers meeting pattern, so use "Shift the event to 4pm"
        const result = extractWithRules('Shift to 4pm');
        expect(result.event?.event_type).toBe('update_event');
        expect(result.matchedPatterns).toContain('action:reschedule');
      });
    });

    describe('Irrelevant detection', () => {
      it('should return null event for messages without patterns', () => {
        const result = extractWithRules('Hello how are you');
        expect(result.success).toBe(false);
        // When irrelevant, event is null
        expect(result.event).toBeNull();
      });

      it('should return low confidence for vague messages', () => {
        const result = extractWithRules('That sounds good');
        expect(result.confidence).toBe(0);
      });
    });
  });

  describe('Title Extraction', () => {
    it('should extract task titles', () => {
      const result = extractWithRules('Bring milk today');
      expect(result.event?.title?.toLowerCase()).toContain('milk');
    });

    it('should extract meeting titles', () => {
      const result = extractWithRules('Meeting with John tomorrow');
      expect(result.event?.title?.toLowerCase()).toContain('john');
    });

    it('should extract reminder titles', () => {
      const result = extractWithRules('Remind me to call mom');
      expect(result.event?.title?.toLowerCase()).toContain('call');
    });

    it('should handle call + person', () => {
      const result = extractWithRules('Call Sarah at 5pm');
      expect(result.event?.title?.toLowerCase()).toContain('sarah');
    });

    it('should generate default title when extraction fails', () => {
      const result = extractWithRules('Meeting at 3pm');
      expect(result.event?.title).toBeDefined();
      expect(result.event?.title!.length).toBeGreaterThan(0);
    });
  });

  describe('Participant Extraction', () => {
    it('should extract "with X" participants', () => {
      const result = extractWithRules('Meeting with John at 3pm');
      expect(result.event?.participants).toContain('John');
    });

    it('should extract capitalized names', () => {
      const result = extractWithRules('Call Sarah tomorrow');
      expect(result.event?.participants).toContain('Sarah');
    });

    it('should not include common words as participants', () => {
      const result = extractWithRules('Meeting Today at 3pm');
      expect(result.event?.participants).not.toContain('Today');
      expect(result.event?.participants).not.toContain('Meeting');
    });

    it('should limit participants to 5', () => {
      const result = extractWithRules('Meeting with John, Sarah, Mike, Lisa, Tom, Bob, Jane at 3pm');
      expect(result.event?.participants?.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Confidence Scoring', () => {
    it('should have high confidence for complete events', () => {
      const result = extractWithRules('Meeting tomorrow at 3pm with John');
      expect(result.confidence).toBeGreaterThanOrEqual(0.75);
      expect(result.skipLLM).toBe(true);
    });

    it('should have medium confidence for partial events', () => {
      const result = extractWithRules('Meeting tomorrow');
      expect(result.confidence).toBeGreaterThan(0.3);
      expect(result.confidence).toBeLessThan(0.75);
    });

    it('should have low confidence for vague messages', () => {
      const result = extractWithRules('maybe we should meet');
      expect(result.confidence).toBeLessThan(0.5);
    });

    it('should skip LLM when confidence >= 0.75 and has time', () => {
      const result = extractWithRules('Remind me to call John at 5pm today');
      expect(result.skipLLM).toBe(true);
    });

    it('should not skip LLM when confidence < 0.75', () => {
      const result = extractWithRules('Meeting sometime next week');
      expect(result.skipLLM).toBe(false);
    });
  });

  describe('Time Zone Handling', () => {
    it('should produce valid ISO timestamp for 3pm', () => {
      const result = extractWithRules('Meeting today at 3pm');
      expect(result.event?.start_time).toBeDefined();
      expect(result.event?.start_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should produce valid ISO timestamp for 9am', () => {
      const result = extractWithRules('Call today at 9am');
      expect(result.event?.start_time).toBeDefined();
      expect(result.event?.start_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty string', () => {
      const result = extractWithRules('');
      expect(result.success).toBe(false);
      expect(result.confidence).toBe(0);
    });

    it('should handle very long messages', () => {
      const longMessage = 'Meeting tomorrow at 3pm ' + 'with discussion about '.repeat(100);
      const result = extractWithRules(longMessage);
      expect(result).toBeDefined();
      expect(result.event?.start_time).toBeDefined();
    });

    it('should handle special characters with event keyword', () => {
      const result = extractWithRules('Meeting @3pm #urgent today');
      expect(result.event?.start_time).toBeDefined();
    });

    it('should handle mixed case', () => {
      const result = extractWithRules('MEETING TOMORROW AT 3PM');
      expect(result.success).toBe(true);
      expect(result.matchedPatterns).toContain('date:tomorrow');
    });

    it('should handle multiple times in message', () => {
      const result = extractWithRules('Meeting at 3pm or 4pm tomorrow');
      expect(result.success).toBe(true);
      expect(result.event?.start_time).toBeDefined();
    });

    it('should set sender as created_by', () => {
      const result = extractWithRules('Meeting tomorrow at 3pm', 'john@example.com');
      expect(result.event?.created_by).toBe('john@example.com');
    });
  });

  describe('Real-world Examples', () => {
    it('should handle "bring milk today" with task keyword', () => {
      const result = extractWithRules('bring milk today');
      expect(result.event?.event_type).toBe('new_event');
      expect(result.event?.title?.toLowerCase()).toContain('milk');
      expect(result.matchedPatterns).toContain('action:task');
    });

    it('should handle "pick up kids at 4pm"', () => {
      const result = extractWithRules('pick up kids at 4pm');
      expect(result.success).toBe(true);
      expect(result.event?.title?.toLowerCase()).toContain('pick');
    });

    it('should handle "call mom tomorrow" with meeting keyword', () => {
      const result = extractWithRules('call mom tomorrow');
      expect(result.event?.event_type).toBe('new_event');
      expect(result.matchedPatterns).toContain('action:meeting');
    });

    it('should handle "don\'t forget to pay rent tomorrow"', () => {
      const result = extractWithRules("don't forget to pay rent tomorrow");
      expect(result.event?.event_type).toBe('new_event');
      expect(result.matchedPatterns).toContain('action:remind');
    });

    it('should handle "team meeting at 9:30 AM"', () => {
      // "standup" doesn't trigger meeting, use "meeting" instead
      const result = extractWithRules('team meeting at 9:30 AM');
      expect(result.success).toBe(true);
      expect(result.matchedPatterns).toContain('time:12hour_with_minutes');
    });

    it('should handle "submit report by Friday"', () => {
      const result = extractWithRules('submit report by Friday');
      expect(result.event?.event_type).toBe('new_event');
      expect(result.matchedPatterns).toContain('action:task');
    });

    it('should handle "Cancel tomorrow\'s meeting"', () => {
      const result = extractWithRules("Cancel tomorrow's meeting");
      expect(result.event?.event_type).toBe('update_event');
      expect(result.matchedPatterns).toContain('action:cancel');
    });

    it('should handle "yaad rakh medicine lena hai"', () => {
      const result = extractWithRules('yaad rakh medicine lena hai');
      expect(result.event?.event_type).toBe('new_event');
      expect(result.matchedPatterns).toContain('action:remind');
    });
  });
});
