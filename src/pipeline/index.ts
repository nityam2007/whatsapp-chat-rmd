/**
 * Main Pipeline Orchestrator
 * 
 * Coordinates the full message processing pipeline with detailed logging.
 * 
 * PIPELINE FLOW:
 * 1. Store raw message FIRST (always save all data)
 * 2. Check for duplicate processing (message_id deduplication)
 * 3. Heuristic Gate (save result)
 * 4. AI Classification (save result)
 * 5. Context Building
 * 6. Token Compression (if needed)
 * 7. AI Extraction (save result)
 * 8. Event Routing (with FAISS deduplication)
 * 9. Mark pipeline complete
 */

import { StoredMessage, StoredEvent } from '../types/index.js';
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
} from '../database/sqlite.js';
import { checkHeuristicGate } from './heuristicGate.js';
import { classifyMessage } from './classifier.js';
import { buildContext, formatContextForLLM } from './contextBuilder.js';
import { compressIfNeeded } from './tokenCompressor.js';
import { extractWithRules } from './ruleEngine.js';
import { extractEvent } from './extractor.js';
import { routeEvent } from './eventRouter.js';
import { detectIntent, formatMatchedEventsContext } from './intentDetector.js';
import logger from '../utils/logger.js';
import { metrics, createTimer } from '../utils/metrics.js';
import {
  logHeuristic,
  logClassification,
  logContext,
  logExtraction,
  logRouting,
  logError,
  PipelineLogContext,
} from '../utils/pipelineLogger.js';

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
      classification_type: null,
      classification_confidence: null,
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
    // Step 3: Heuristic Gate (save result regardless of outcome)
    // =====================================
    timer.mark('heuristic_start');
    const heuristicResult = checkHeuristicGate(message.content);
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
      },
      duration_ms: heuristicDuration,
    });
    
    // Log heuristic result
    logHeuristic(logCtx, heuristicResult);
    
    if (!heuristicResult.hasSignal) {
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
        messageCount: context.messages.length, 
        tokenCount: context.tokenCount,
      },
      duration_ms: contextDuration,
    });
    
    logger.debug('Context built', {
      messageId: message.id,
      messageCount: context.messages.length,
      tokenCount: context.tokenCount,
      duration: contextDuration,
    });

    // =====================================
    // Step 6: Compress if needed
    // =====================================
    const processedContext = await compressIfNeeded(context);
    
    // Log context info
    logContext(logCtx, {
      messageCount: processedContext.messages.length,
      tokenCount: processedContext.tokenCount,
      compressed: processedContext.compressed,
    });
    
    storePipelineLog({
      message_id: message.id,
      stage: 'compression',
      status: processedContext.compressed ? 'compressed' : 'skipped',
      data: { 
        compressed: processedContext.compressed, 
        tokenCount: processedContext.tokenCount,
      },
    });
    
    logger.debug('Context processed', {
      messageId: message.id,
      compressed: processedContext.compressed,
      tokenCount: processedContext.tokenCount,
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

export default { processMessage, getPipelineMetrics, getMetricsSummary, logMetricsSummary };
