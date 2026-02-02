/**
 * Heuristic Gate Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { checkHeuristicGate } from '../../src/pipeline/heuristicGate.js';

describe('Heuristic Gate', () => {
  describe('Signal Detection', () => {
    it('should detect time-related signals', () => {
      const result = checkHeuristicGate('Meeting tomorrow at 3pm');
      expect(result.hasSignal).toBe(true);
      expect(result.score).toBeGreaterThan(0);
      expect(result.signals).toContainEqual(expect.stringContaining('time'));
    });

    it('should detect event keywords', () => {
      const result = checkHeuristicGate('Let\'s schedule a meeting');
      expect(result.hasSignal).toBe(true);
      expect(result.signals.some(s => s.includes('meeting'))).toBe(true);
    });

    it('should detect strong time patterns', () => {
      const patterns = [
        '10:30 AM',
        '15:00',
        'January 15th',
        '2024-12-25',
        '12/25',
      ];

      patterns.forEach(pattern => {
        const result = checkHeuristicGate(`Event at ${pattern}`);
        expect(result.hasSignal).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(3);
      });
    });

    it('should detect reminder phrases with time', () => {
      const phrases = [
        'Remind me to call John tomorrow',
        'Don\'t forget the meeting at 3pm',
        'Remember to submit the report by Monday',
      ];

      phrases.forEach(phrase => {
        const result = checkHeuristicGate(phrase);
        expect(result.hasSignal).toBe(true);
      });
    });

    it('should detect update signals', () => {
      const result = checkHeuristicGate('The meeting has been rescheduled to 5pm');
      expect(result.hasSignal).toBe(true);
      expect(result.signals.some(s => s.includes('update'))).toBe(true);
    });

    it('should detect location signals with events', () => {
      const result = checkHeuristicGate('Meet me at the office tomorrow');
      expect(result.hasSignal).toBe(true);
    });
  });

  describe('Regional Language Support', () => {
    describe('Hindi/Hinglish', () => {
      it('should detect Hindi time words', () => {
        const phrases = [
          'kal meeting hai',           // tomorrow meeting
          'aaj 3 baje milte hai',      // today 3 o'clock meet
          'abhi call karo',            // call now
          'shaam ko milna hai',        // evening meeting
          'parso jana hai',            // day after tomorrow go
        ];

        phrases.forEach(phrase => {
          const result = checkHeuristicGate(phrase);
          expect(result.hasSignal).toBe(true);
        });
      });

      it('should detect Hindi reminder patterns', () => {
        const phrases = [
          'yaad rakh medicine lena hai',
          'bhool mat bill pay karna',
          'yaad dilana call karne ka',
        ];

        phrases.forEach(phrase => {
          const result = checkHeuristicGate(phrase);
          expect(result.hasSignal).toBe(true);
        });
      });

      it('should detect Hinglish action words', () => {
        const phrases = [
          'doodh lana hai',            // bring milk
          'ghar aana hai 5 baje',      // come home at 5
          'office jana hai kal',       // go to office tomorrow
        ];

        phrases.forEach(phrase => {
          const result = checkHeuristicGate(phrase);
          expect(result.hasSignal).toBe(true);
        });
      });
    });

    describe('Tamil', () => {
      it('should detect Tamil time words', () => {
        const phrases = [
          'naalai meeting iruku',      // tomorrow meeting
          'inru call pannu',           // call today
          'kaalaila vanga',            // come in morning
        ];

        phrases.forEach(phrase => {
          const result = checkHeuristicGate(phrase);
          expect(result.hasSignal).toBe(true);
        });
      });

      it('should detect Tamil reminder patterns', () => {
        const result = checkHeuristicGate('marakkathe office poga');
        expect(result.hasSignal).toBe(true);
      });
    });

    describe('Telugu', () => {
      it('should detect Telugu time words', () => {
        const phrases = [
          'repu meeting undi',         // tomorrow meeting
          'eeroju call cheyyi',        // call today
        ];

        phrases.forEach(phrase => {
          const result = checkHeuristicGate(phrase);
          expect(result.hasSignal).toBe(true);
        });
      });

      it('should detect Telugu reminder patterns', () => {
        const result = checkHeuristicGate('marchipoku medicine teesuko');
        expect(result.hasSignal).toBe(true);
      });
    });

    describe('Marathi', () => {
      it('should detect Marathi time words', () => {
        const phrases = [
          'udya meeting ahe',          // tomorrow meeting
          'aaj phone kara',            // call today
        ];

        phrases.forEach(phrase => {
          const result = checkHeuristicGate(phrase);
          expect(result.hasSignal).toBe(true);
        });
      });

      it('should detect Marathi reminder patterns', () => {
        const result = checkHeuristicGate('visaru naka bill bhara');
        expect(result.hasSignal).toBe(true);
      });
    });

    describe('Bengali', () => {
      it('should detect Bengali time words', () => {
        const phrases = [
          'kal meeting ache',          // tomorrow meeting
          'aj call korbe',             // call today
          'porsu asho',                // come day after tomorrow
        ];

        phrases.forEach(phrase => {
          const result = checkHeuristicGate(phrase);
          expect(result.hasSignal).toBe(true);
        });
      });

      it('should detect Bengali reminder patterns', () => {
        const result = checkHeuristicGate('bhulona medicine khete');
        expect(result.hasSignal).toBe(true);
      });
    });

    describe('Gujarati', () => {
      it('should detect Gujarati time words', () => {
        const phrases = [
          'kale meeting che',          // tomorrow meeting
          'aaje call karo',            // call today
        ];

        phrases.forEach(phrase => {
          const result = checkHeuristicGate(phrase);
          expect(result.hasSignal).toBe(true);
        });
      });

      it('should detect Gujarati reminder patterns', () => {
        const result = checkHeuristicGate('bhulta nahi dawai leva');
        expect(result.hasSignal).toBe(true);
      });
    });
  });

  describe('Irrelevant Messages', () => {
    it('should not flag simple greetings', () => {
      const greetings = ['Hi', 'Hello', 'Hey', 'Ok', 'Thanks'];
      
      greetings.forEach(greeting => {
        const result = checkHeuristicGate(greeting);
        expect(result.hasSignal).toBe(false);
      });
    });

    it('should not flag random chat', () => {
      const messages = [
        'lol that\'s funny',
        'I agree with you',
        'Nice picture!',
      ];

      messages.forEach(msg => {
        const result = checkHeuristicGate(msg);
        expect(result.score).toBeLessThan(2);
      });
    });

    it('should handle empty strings', () => {
      const result = checkHeuristicGate('');
      expect(result.hasSignal).toBe(false);
      expect(result.score).toBe(0);
    });

    it('should handle very short messages', () => {
      const result = checkHeuristicGate('ok');
      expect(result.hasSignal).toBe(false);
    });
  });

  describe('Score Calculation', () => {
    it('should give higher score for multiple signals', () => {
      const singleSignal = checkHeuristicGate('tomorrow');
      const multipleSignals = checkHeuristicGate('Meeting tomorrow at 3pm in the office');
      
      expect(multipleSignals.score).toBeGreaterThan(singleSignal.score);
    });

    it('should give highest score for strong patterns', () => {
      const strongPattern = checkHeuristicGate('Remind me at 10:30 AM tomorrow');
      expect(strongPattern.score).toBeGreaterThanOrEqual(5);
    });
  });

  describe('Edge Cases', () => {
    it('should handle special characters', () => {
      const result = checkHeuristicGate('Meeting @10:30! #important');
      expect(result.hasSignal).toBe(true);
    });

    it('should handle case insensitivity', () => {
      const lower = checkHeuristicGate('meeting tomorrow at noon');
      const upper = checkHeuristicGate('MEETING TOMORROW AT NOON');
      const mixed = checkHeuristicGate('MeEtInG ToMoRrOw At NoOn');

      expect(lower.hasSignal).toBe(upper.hasSignal);
      expect(lower.hasSignal).toBe(mixed.hasSignal);
    });
  });
});
