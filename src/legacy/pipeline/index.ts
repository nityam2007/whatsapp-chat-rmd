/**
 * Main Pipeline Orchestrator
 * 
 * Coordinates the full message processing pipeline with detailed logging.
 * 
 * ENHANCED WITH SEMANTIC LEARNING:
 * - Stores embeddings for messages that create events
 * - Learns patterns from successful extractions
 * - Uses semantic similarity for improved accuracy
 * 
 * PIPELINE FLOW:
 * 1. Store raw message FIRST (always save all data)
 * 2. Check for duplicate processing (message_id deduplication)
 * 3. Heuristic Gate (save result) - with optional semantic boost
 * 4. AI Classification (save result) - with few-shot examples
 * 5. Context Building - with semantic examples
 * 6. Token Compression (if needed)
 * 7. AI Extraction (save result)
 * 8. Event Routing (with FAISS deduplication)
 * 9. Store message embedding for learning
 * 10. Mark pipeline complete
 */

import { StoredMessage, StoredEvent } from '../../types/index.js';
import { 
  messageExists,
  storeEnhancedMessage,
  updateMessageHeuristic,
  updateMessageClassification,
  updateMessageExtraction,
  updateMessagePipelineComplete,
  storePipelineLog,
  eventExistsForMessage,
  getEventBySourceMessage,
  getRecentEventsByChat,
  getDatabase,
} from '../../database/sqlite.js';
import { checkHeuristicGate } from '../../pipeline/heuristicGate.js';
import { classifyMessage } from './classifier.js';
import { buildContext, formatContextForLLM } from './contextBuilder.js';
import { compressIfNeeded } from './tokenCompressor.js';
import { extractWithRules } from './ruleEngine.js';
import { extractEvent } from './extractor.js';
import { routeEvent } from './eventRouter.js';
import { detectIntent, formatMatchedEventsContext } from './intentDetector.js';
import logger from '../../utils/logger.js';
import { metrics, createTimer } from '../../utils/metrics.js';
import {
  logHeuristic,
  logClassification,
  logContext,
  logExtraction,
  logRouting,
  logError,
  PipelineLogContext,
} from '../../utils/pipelineLogger.js';
import { storeMessageEmbedding, learnPattern } from '../vector/semanticSearch.js';
import { checkForProactiveTriggers } from '../../services/proactiveTrigger.js';
import { extractContextTags } from '../services/contextMatcher.js';

// Configuration for semantic enhancement
const USE_SEMANTIC_HEURISTIC = true; // Enable semantic boost for heuristic gate
const USE_SEMANTIC_LEARNING = true; // Enable learning from successful extractions

/**
 * Processes a message through the full pipeline
 * 
 * Key features:
 * - Saves ALL messages for data collection
 * - Saves pipeline results at each stage
 * - Deduplication at message and event level
 * - Comprehensive error handling
 * - Performance metrics tracking
 */
export async function processMessage(message: StoredMessage): Promise<StoredEvent | null> {
  const timer = createTimer();
  logger.info('Starting pipeline', { messageId: message.id, sender: message.sender });
  
  // Record message processing started
  metrics.recordMessageProcessed();
  
  // Create log context for pipeline logging
  const logCtx: PipelineLogContext = {
    messageId: message.id,
    sender: message.sender,
    chatId: message.chat_id,
    content: message.content,
  };
  
  try {
    // =====================================
    // Step 1: Check for duplicate message (deduplication)
    // =====================================
    if (messageExists(message.id)) {
      logger.debug('Duplicate message detected, checking if already processed', { messageId: message.id });
      
      // Check if we already created an event for this message
      const existingEvent = getEventBySourceMessage(message.id);
      if (existingEvent) {
        logger.info('Message already processed with event', { 
          messageId: message.id, 
          eventId: existingEvent.id 
        });
        return existingEvent;
      }
      
      // Message exists but no event - continue processing (might have failed before)
      logger.debug('Message exists but no event, continuing pipeline', { messageId: message.id });
    }

    // =====================================
    // Step 2: Store raw message FIRST (always collect data)
    // =====================================
    storeEnhancedMessage({
      ...message,
      heuristic_passed: null,  // Will be updated
      heuristic_score: null,
      heuristic_signals: null,
      extraction_success: null,
      extraction_event_id: null,
      pipeline_completed: false,
      pipeline_error: null,
    });
    
    storePipelineLog({
      message_id: message.id,
      stage: 'received',
      status: 'success',
      data: { sender: message.sender, contentLength: message.content.length },
      duration_ms: timer.elapsed(),
    });
    
    logger.debug('Message stored', { messageId: message.id });

    // =====================================
    // Step 2.5: PROACTIVE TRIGGER CHECK (runs for ALL messages!)
    // This uses Gemini to detect if this message relates to any pending events
    // Example: "Just reached Goa" → triggers "Get cashew from Goa"
    // =====================================
    try {
      const proactiveMatches = await checkForProactiveTriggers(message);
      
      if (proactiveMatches.length > 0) {
        storePipelineLog({
          message_id: message.id,
          stage: 'proactive_trigger',
          status: 'triggered',
          data: { 
            matchCount: proactiveMatches.length,
            matches: proactiveMatches.map(m => ({
              eventId: m.event.id,
              eventTitle: m.event.title,
              reason: m.matchReason,
              confidence: m.confidence,
            })),
          },
          duration_ms: timer.elapsed(),
        });
        
        logger.info('Proactive triggers sent', {
          messageId: message.id,
          matchCount: proactiveMatches.length,
        });
      }
    } catch (proactiveError) {
      // Don't fail the pipeline for proactive trigger errors
      logger.warn('Proactive trigger check failed', { error: proactiveError, messageId: message.id });
    }

    // =====================================
    // Step 3: Heuristic Gate (with optional semantic boost)
    // =====================================
    timer.mark('heuristic_start');
    
    // Use semantic-enhanced heuristic gate for better accuracy
    let heuristicResult;
    let usedSemanticBoost = false;
    
    if (USE_SEMANTIC_HEURISTIC) {
      try {
        heuristicResult = checkHeuristicGate(message.content);
        usedSemanticBoost = !!(heuristicResult as any).semanticBoost;
      } catch (error) {
        logger.warn('Semantic heuristic failed, using basic', { error });
        heuristicResult = checkHeuristicGate(message.content);
      }
    } else {
      heuristicResult = checkHeuristicGate(message.content);
    }
    
    timer.mark('heuristic_end');
    const heuristicDuration = timer.duration('heuristic_start', 'heuristic_end');
    
    // Save heuristic result to database
    updateMessageHeuristic(
      message.id, 
      heuristicResult.hasSignal, 
      heuristicResult.score, 
      heuristicResult.signals
    );
    
    storePipelineLog({
      message_id: message.id,
      stage: 'heuristic',
      status: heuristicResult.hasSignal ? 'passed' : 'dropped',
      data: { 
        score: heuristicResult.score, 
        signalCount: heuristicResult.signals.length,
        topSignals: heuristicResult.signals.slice(0, 5),
        usedSemanticBoost,
        semanticBoost: (heuristicResult as any).semanticBoost,
        semanticCategory: (heuristicResult as any).semanticCategory,
      },
      duration_ms: heuristicDuration,
    });
    
    // Log heuristic result
    logHeuristic(logCtx, heuristicResult);
    
    if (!heuristicResult.hasSignal) {
      // =====================================
      // Check if this is a NEGATION that should cancel existing events
      // Example: "dont bring potato" should cancel existing "bring potato" event
      // =====================================
      const negationCancelResult = await checkNegationCancellation(message, logCtx);
      if (negationCancelResult) {
        storePipelineLog({
          message_id: message.id,
          stage: 'negation_cancel',
          status: 'cancelled_event',
          data: { 
            cancelledEventId: negationCancelResult.id,
            cancelledEventTitle: negationCancelResult.title,
            reason: 'negation_detected',
          },
          duration_ms: timer.elapsed(),
        });
        
        logger.info('Negation cancelled existing event', {
          messageId: message.id,
          cancelledEventId: negationCancelResult.id,
          cancelledEventTitle: negationCancelResult.title,
        });
        
        updateMessagePipelineComplete(message.id);
        return negationCancelResult;
      }
      
      logger.debug('No signal found, message saved but not processed further', { 
        messageId: message.id,
        score: heuristicResult.score,
      });
      
      // Record metrics
      metrics.recordHeuristicDrop();
      metrics.recordTiming({ heuristic: heuristicDuration, total: timer.elapsed() });
      
      updateMessagePipelineComplete(message.id);
      return null;
    }
    
    // Record heuristic pass
    metrics.recordHeuristicPass();
    
    logger.debug('Signal found', { 
      messageId: message.id,
      signals: heuristicResult.signals.slice(0, 3),
      score: heuristicResult.score,
    });

    // =====================================
    // Step 4: Small LLM Classification (save result)
    // =====================================
    timer.mark('classification_start');
    const classification = await classifyMessage(message.content);
    timer.mark('classification_end');
    const classificationDuration = timer.duration('classification_start', 'classification_end');
    
    // Save classification result to database
    updateMessageClassification(message.id, classification.event_type, classification.confidence);
    
    storePipelineLog({
      message_id: message.id,
      stage: 'classification',
      status: classification.event_type === 'irrelevant' ? 'irrelevant' : 'relevant',
      data: { 
        eventType: classification.event_type, 
        confidence: classification.confidence,
      },
      duration_ms: classificationDuration,
    });
    
    // Log classification result
    logClassification(logCtx, classification);
    
    logger.debug('Classification completed', {
      messageId: message.id,
      eventType: classification.event_type,
      confidence: classification.confidence,
      duration: classificationDuration,
    });
    
    if (classification.event_type === 'irrelevant') {
      logger.debug('Classified as irrelevant', { 
        messageId: message.id,
        confidence: classification.confidence,
      });
      
      metrics.recordTiming({ heuristic: heuristicDuration, total: timer.elapsed() });
      updateMessagePipelineComplete(message.id);
      return null;
    }

    // =====================================
    // Step 5: Intent Detection (FAISS-based for cancel/update/reschedule)
    // =====================================
    timer.mark('intent_start');
    const intentResult = await detectIntent(message);
    timer.mark('intent_end');
    const intentDuration = timer.duration('intent_start', 'intent_end');
    
    storePipelineLog({
      message_id: message.id,
      stage: 'intent_detection',
      status: intentResult.intent !== 'none' ? 'detected' : 'none',
      data: { 
        intent: intentResult.intent,
        confidence: intentResult.confidence,
        keywords: intentResult.keywords,
        matchedEventCount: intentResult.matchedEvents.length,
        matchedEventIds: intentResult.matchedEvents.map(e => e.id),
      },
      duration_ms: intentDuration,
    });
    
    logger.debug('Intent detection completed', {
      messageId: message.id,
      intent: intentResult.intent,
      matchedEvents: intentResult.matchedEvents.length,
      duration: intentDuration,
    });

    // =====================================
    // Step 6: Build Context
    // =====================================
    timer.mark('context_start');
    const context = await buildContext(message);
    timer.mark('context_end');
    const contextDuration = timer.duration('context_start', 'context_end');
    
    storePipelineLog({
      message_id: message.id,
      stage: 'context',
      status: 'success',
      data: { 
        messageCount: context.messages?.length ?? 0,
        tokenCount: context.tokenCount ?? 0,
      },
      duration_ms: contextDuration,
    });
    
    logger.debug('Context built', {
      messageId: message.id,
      messageCount: context.messages?.length ?? 0,
      tokenCount: context.tokenCount ?? 0,
      duration: contextDuration,
    });

    // =====================================
    // Step 6: Compress if needed
    // =====================================
    const processedContext = await compressIfNeeded(context);
    
    // Log context info
    logContext(logCtx, {
      messageCount: processedContext.messages?.length ?? 0,
      tokenCount: processedContext.tokenCount ?? 0,
      compressed: processedContext.compressed ?? false,
    });
    
    storePipelineLog({
      message_id: message.id,
      stage: 'compression',
      status: processedContext.compressed ? 'compressed' : 'skipped',
      data: { 
        compressed: processedContext.compressed ?? false,
        tokenCount: processedContext.tokenCount ?? 0,
      },
    });
    
    logger.debug('Context processed', {
      messageId: message.id,
      compressed: processedContext.compressed ?? false,
      tokenCount: processedContext.tokenCount ?? 0,
    });

    // =====================================
    // Step 8: Format context for LLM (include matched events if intent detected)
    // =====================================
    let formattedContext = formatContextForLLM(processedContext);
    
    // Append matched events context if we detected a cancel/update/reschedule intent
    if (intentResult.intent !== 'none' && intentResult.matchedEvents.length > 0) {
      const matchedEventsContext = formatMatchedEventsContext(intentResult.matchedEvents);
      formattedContext += matchedEventsContext;
      
      logger.debug('Added matched events to context', {
        messageId: message.id,
        intent: intentResult.intent,
        matchedEventCount: intentResult.matchedEvents.length,
      });
    }

    // =====================================
    // Step 9: Rule Engine Extraction (FAST - no LLM)
    // =====================================
    timer.mark('rule_engine_start');
    const ruleResult = extractWithRules(message.content, message.sender);
    timer.mark('rule_engine_end');
    const ruleEngineDuration = timer.duration('rule_engine_start', 'rule_engine_end');
    
    storePipelineLog({
      message_id: message.id,
      stage: 'rule_engine',
      status: ruleResult.skipLLM ? 'extracted' : 'deferred_to_llm',
      data: { 
        confidence: ruleResult.confidence,
        matchedPatterns: ruleResult.matchedPatterns.length,
        skipLLM: ruleResult.skipLLM,
        title: ruleResult.event?.title,
      },
      duration_ms: ruleEngineDuration,
    });
    
    logger.debug('Rule engine completed', {
      messageId: message.id,
      confidence: ruleResult.confidence,
      skipLLM: ruleResult.skipLLM,
      patternsMatched: ruleResult.matchedPatterns.length,
      duration: ruleEngineDuration,
    });

    // Use rule engine result if confident enough, otherwise fall back to LLM
    let extractedEvent;
    let llmDuration = 0;
    let needsConfirmation = false;  // Flag for events that need user confirmation
    
    if (ruleResult.skipLLM && ruleResult.event) {
      // Rule engine was confident - skip LLM
      extractedEvent = ruleResult.event;
      
      // Check if this event needs user confirmation
      // Events need confirmation if they're tasks without explicit time
      // or if they have a contextual trigger instead of a fixed time
      needsConfirmation = (ruleResult.isTask && !extractedEvent.start_time) ||
                          ruleResult.hasContextualTrigger;
      
      // Record metrics - rule engine success
      metrics.recordRuleEngineExtraction();
      
      logger.info('Using rule engine extraction (skipped LLM)', {
        messageId: message.id,
        confidence: ruleResult.confidence,
        title: extractedEvent.title,
        needsConfirmation,
        isTask: ruleResult.isTask,
        hasContextualTrigger: ruleResult.hasContextualTrigger,
      });
      
      storePipelineLog({
        message_id: message.id,
        stage: 'extraction',
        status: 'rule_engine_extracted',
        data: { 
          eventType: extractedEvent.event_type,
          title: extractedEvent.title,
          confidence: extractedEvent.confidence,
          startTime: extractedEvent.start_time,
          source: 'rule_engine',
          needsConfirmation,
          isTask: ruleResult.isTask,
          hasContextualTrigger: ruleResult.hasContextualTrigger,
          contextualTrigger: ruleResult.contextualTrigger,
        },
        duration_ms: ruleEngineDuration,
      });
    } else {
      // =====================================
      // Step 10: Big LLM Extraction (fallback for complex cases)
      // =====================================
      timer.mark('llm_start');
      extractedEvent = await extractEvent(formattedContext);
      timer.mark('llm_end');
      llmDuration = timer.duration('llm_start', 'llm_end');
      
      // Record LLM extraction
      metrics.recordLlmExtraction();
      
      storePipelineLog({
        message_id: message.id,
        stage: 'extraction',
        status: extractedEvent.event_type === 'irrelevant' ? 'irrelevant' : 'extracted',
        data: { 
          eventType: extractedEvent.event_type,
          title: extractedEvent.title,
          confidence: extractedEvent.confidence,
          startTime: extractedEvent.start_time,
          endTime: extractedEvent.end_time,
          participants: extractedEvent.participants,
          createdBy: extractedEvent.created_by,
          condition: extractedEvent.condition,
          source: 'llm',
        },
        duration_ms: llmDuration,
      });
      
      logger.debug('LLM extraction completed', {
        messageId: message.id,
        eventType: extractedEvent.event_type,
        title: extractedEvent.title,
        confidence: extractedEvent.confidence,
        duration: llmDuration,
      });
    }
    
    // Log extraction result
    logExtraction(logCtx, extractedEvent);
    
    // Validate extraction result
    if (extractedEvent.event_type === 'irrelevant' || extractedEvent.confidence < 0.3) {
      logger.debug('Extraction result irrelevant or low confidence', {
        messageId: message.id,
        eventType: extractedEvent.event_type,
        confidence: extractedEvent.confidence,
      });
      
      metrics.recordTiming({
        heuristic: heuristicDuration,
        ruleEngine: ruleEngineDuration,
        llm: llmDuration,
        total: timer.elapsed(),
      });
      
      updateMessageExtraction(message.id, false);
      updateMessagePipelineComplete(message.id);
      return null;
    }
    
    logger.info('Event extracted', {
      messageId: message.id,
      eventType: extractedEvent.event_type,
      title: extractedEvent.title,
      confidence: extractedEvent.confidence,
    });

    // =====================================
    // Step 8.5: Extract Context Tags for Proactive Triggers
    // This populates context_tags, location, trigger_keywords for future matching
    // =====================================
    try {
      const contextData = await extractContextTags(message.content, extractedEvent.title || '');
      
      // Merge context data into extracted event
      extractedEvent.context_tags = contextData.context_tags;
      extractedEvent.location = contextData.location;
      extractedEvent.trigger_keywords = contextData.trigger_keywords;
      
      storePipelineLog({
        message_id: message.id,
        stage: 'context_extraction',
        status: 'success',
        data: { 
          context_tags: contextData.context_tags,
          location: contextData.location,
          trigger_keywords: contextData.trigger_keywords,
        },
        duration_ms: timer.elapsed(),
      });
      
      logger.debug('Context tags extracted', {
        messageId: message.id,
        context_tags: contextData.context_tags,
        location: contextData.location,
      });
    } catch (contextError) {
      // Don't fail for context extraction errors
      logger.warn('Context tag extraction failed', { error: contextError, messageId: message.id });
    }

    // =====================================
    // Step 9: Check for duplicate event (FAISS-based deduplication)
    // =====================================
    if (eventExistsForMessage(message.id)) {
      const existingEvent = getEventBySourceMessage(message.id);
      logger.info('Event already exists for this message', { 
        messageId: message.id,
        existingEventId: existingEvent?.id,
      });
      
      storePipelineLog({
        message_id: message.id,
        stage: 'routing',
        status: 'duplicate_skipped',
        data: { existingEventId: existingEvent?.id },
      });
      
      updateMessageExtraction(message.id, true, existingEvent?.id);
      updateMessagePipelineComplete(message.id);
      return existingEvent;
    }

    // =====================================
    // Step 10: Route Event
    // =====================================
    timer.mark('routing_start');
    const storedEvent = await routeEvent(extractedEvent, message, { needsConfirmation });
    timer.mark('routing_end');
    const routingDuration = timer.duration('routing_start', 'routing_end');
    
    if (storedEvent) {
      // Update message with extraction result
      updateMessageExtraction(message.id, true, storedEvent.id);
      
      // Record event creation/update
      if (extractedEvent.event_type === 'new_event') {
        metrics.recordEventCreated();
      } else if (extractedEvent.event_type === 'update_event') {
        metrics.recordEventUpdated();
      }
      
      // =====================================
      // Step 11: Semantic Learning (store embedding for future similarity)
      // =====================================
      if (USE_SEMANTIC_LEARNING) {
        try {
          // Store message embedding for future similarity searches
          await storeMessageEmbedding(
            message.id,
            message.chat_id,
            message.content,
            extractedEvent.event_type,
            true, // createdEvent
            storedEvent.id
          );
          
          // Learn pattern from successful extraction
          // Determine category based on event type
          let category: 'event' | 'reminder' | 'deadline' | 'meeting' | 'update' | 'cancel' = 'event';
          const titleLower = (extractedEvent.title || '').toLowerCase();
          if (extractedEvent.event_type === 'update_event') {
            category = 'update';
          } else if (titleLower.includes('remind') || titleLower.includes('don\'t forget')) {
            category = 'reminder';
          } else if (titleLower.includes('deadline') || titleLower.includes('due')) {
            category = 'deadline';
          } else if (titleLower.includes('meeting') || titleLower.includes('call') || titleLower.includes('sync')) {
            category = 'meeting';
          }
          
          await learnPattern(
            message.content,
            category,
            extractedEvent.event_type,
            extractedEvent.confidence
          );
          
          logger.debug('Stored semantic learning data', {
            messageId: message.id,
            eventId: storedEvent.id,
            category,
          });
        } catch (error) {
          logger.warn('Failed to store semantic learning data', { error });
          // Don't fail the pipeline for learning errors
        }
      }
      
      // Log routing
      logRouting(logCtx, {
        id: storedEvent.id,
        title: storedEvent.title,
        status: storedEvent.status,
        contact_name: message.sender,
      });
      
      storePipelineLog({
        message_id: message.id,
        stage: 'routing',
        status: 'success',
        data: { 
          eventId: storedEvent.id,
          eventType: extractedEvent.event_type,
          title: storedEvent.title,
          status: storedEvent.status,
        },
        duration_ms: routingDuration,
      });
      
      const totalDuration = timer.elapsed();
      
      // Record final timing
      metrics.recordTiming({
        heuristic: heuristicDuration,
        ruleEngine: ruleEngineDuration,
        llm: llmDuration,
        total: totalDuration,
      });
      
      logger.info('Pipeline completed successfully', {
        messageId: message.id,
        eventId: storedEvent.id,
        eventType: extractedEvent.event_type,
        totalDuration,
      });
      
      updateMessagePipelineComplete(message.id);
    } else {
      updateMessageExtraction(message.id, false);
      updateMessagePipelineComplete(message.id);
    }
    
    return storedEvent;

  } catch (error) {
    // Record error metric
    metrics.recordError();
    
    // Log error
    logError(logCtx, 'pipeline', error);
    
    storePipelineLog({
      message_id: message.id,
      stage: 'error',
      status: 'failed',
      data: { error: String(error) },
      duration_ms: timer.elapsed(),
    });
    
    // Mark pipeline as complete with error
    updateMessagePipelineComplete(message.id, String(error));
    
    logger.error('Pipeline error', { 
      error, 
      messageId: message.id,
      duration: timer.elapsed(),
    });
    throw error;
  }
}

/**
 * Get current pipeline metrics
 */
export function getPipelineMetrics() {
  return metrics.getMetrics();
}

/**
 * Get metrics summary for logging
 */
export function getMetricsSummary() {
  return metrics.getSummary();
}

/**
 * Log current metrics summary
 */
export function logMetricsSummary() {
  metrics.logSummary();
}

/**
 * Check if a negation message should cancel an existing event
 * Example: "dont bring potato" should cancel existing "bring potato" event
 * 
 * @returns The cancelled event if found and cancelled, null otherwise
 */
async function checkNegationCancellation(
  message: StoredMessage,
  _logCtx: PipelineLogContext
): Promise<StoredEvent | null> {
  const content = message.content.toLowerCase().trim();
  
  // Negation patterns that indicate cancellation intent
  const negationPatterns = [
    /\b(don'?t|dont|do\s*not|no\s+need\s*(?:to)?|not\s+required|never|stop|skip)\s+(\w+)/i,
    /\b(mat|nahi|nai|na)\s+(\w+)/i,  // Hindi negation
    /\b(cancel|abort|call\s*off)\s+(the\s+)?(\w+)/i,
  ];
  
  // Check if message matches negation pattern
  let matchedKeyword: string | null = null;
  for (const pattern of negationPatterns) {
    const match = content.match(pattern);
    if (match) {
      // Extract the action word being negated
      matchedKeyword = match[match.length - 1]; // Last capture group
      break;
    }
  }
  
  if (!matchedKeyword) {
    return null;
  }
  
  logger.debug('Negation keyword detected', {
    messageId: message.id,
    matchedKeyword,
    content: content.slice(0, 100),
  });
  
  // Look for recent events in the same chat that might match
  const recentEvents = getRecentEventsByChat(message.chat_id, 20);
  
  if (recentEvents.length === 0) {
    return null;
  }
  
  // Find an event whose title contains the negated keyword
  const db = getDatabase();
  for (const event of recentEvents) {
    const eventTitle = (event.title || '').toLowerCase();
    const eventSource = (event.source_message_content || '').toLowerCase();
    
    // Check if the event title or source contains the keyword being negated
    if (eventTitle.includes(matchedKeyword) || eventSource.includes(matchedKeyword)) {
      // Only cancel if the event is still active/pending
      if (['pending', 'active'].includes(event.status)) {
        logger.info('Found matching event to cancel via negation', {
          messageId: message.id,
          eventId: event.id,
          eventTitle: event.title,
          matchedKeyword,
        });
        
        // Cancel the event
        await db.updateEvent(event.id, {
          status: 'cancelled',
          updated_at: new Date().toISOString(),
        });
        
        // Send notification about cancellation
        const { sendNotification } = await import('../../notifications/index.js');
        await sendNotification({
          type: 'cancelled',
          event_id: event.id,
          title: 'Event Cancelled',
          body: `"${event.title}" cancelled due to: "${message.content.slice(0, 50)}"`,
          data: {
            reason: 'negation',
            sourceMessage: message.content,
          },
        });
        
        // Return the cancelled event
        const cancelledEvent = await db.getEvent(event.id);
        return cancelledEvent;
      }
    }
  }
  
  return null;
}

export default { processMessage, getPipelineMetrics, getMetricsSummary, logMetricsSummary };
