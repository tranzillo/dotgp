import { Game } from './game/Game';
import { TrainingManager } from './ai/TrainingManager';
import { TimeTrialManager } from './timetrials';
import { HTMLTrainingPanel } from './ui/HTMLTrainingPanel';
import { HTMLTracksPanel, TrackGenerationConfig } from './ui/HTMLTracksPanel';
import { lapReplayStorage } from './replay/LapReplayStorage';
import { getNotificationManager } from './ui/NotificationManager';
import { encodeCompositeSeed } from './timetrials/types';
import { backgroundSync, isSupabaseConfigured } from './sync';

function init(): void {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  if (!canvas) {
    throw new Error('Canvas element not found');
  }

  // Create game
  const game = new Game(canvas);

  // Create time trial manager (panel renders to #timetrial-panel DOM element)
  const timeTrialManager = new TimeTrialManager(game, 'timetrial-panel');

  // Create tracks panel for track generation options
  const tracksPanel = new HTMLTracksPanel('tracks-panel', {
    onGenerateTrack: (config: TrackGenerationConfig) => {
      // Set track configuration
      game.setTrackType(config.trackType);
      game.setSizeClass(config.sizeClass);

      // Clear all advanced params first (they'll be set below if provided)
      game.clearAdvancedTrackParams();

      // Oval-specific settings
      if (config.surfaceType) {
        game.setSurfaceType(config.surfaceType);
      }
      if (config.ovalShape) {
        game.setOvalShape(config.ovalShape);
      }

      // Advanced parameters (only set if provided)
      // GP
      game.setGPRoughness(config.roughness);
      game.setGPMaxBankingAngle(config.maxBankingAngle);
      game.setGPNumControlPoints(config.numControlPoints);

      // Oval
      game.setOvalStraightLength(config.straightLength);
      game.setOvalTurnRadius(config.turnRadius);
      game.setOvalTrackWidth(config.trackWidth);
      game.setOvalMaxBankingAngle(config.maxBankingAngle);
      game.setPaperclipEccentricity(config.paperclipEccentricity);
      game.setTriOvalAngle(config.triOvalAngle);
      game.setDoglegIntensity(config.doglegIntensity);

      // Generate track with these settings
      game.generateNewTrackWithCurrentSettings();
    },
    onLoadTrack: (config) => {
      // Load track from seed
      game.loadTrackFromSeed(
        config.baseSeed,
        config.trackType,
        config.sizeClass,
        config.surfaceType,
        config.ovalShape
      );
    },
  });

  // Set initial tracks panel state
  const initialConfig = game.getFullTrackConfig();
  tracksPanel.setCurrentTrack(initialConfig);

  // Create training manager
  const trainingManager = new TrainingManager(game);

  // Create consolidated training panel (replaces replay + agent + reward panels)
  const trainingPanel = new HTMLTrainingPanel('training-panel', {
    onPlayReplay: async (replayId) => {
      const replay = await lapReplayStorage.getReplay(replayId);
      if (replay) {
        game.playLapReplay(replay);
        trainingPanel.setPlayingState(true, replayId);
      }
    },

    onStopReplay: () => {
      game.exitReplayMode();
      trainingPanel.setPlayingState(false);
    },

    onStartTraining: async (agentId, agentName, lapIds, rewardWeights, episodes, mode) => {
      console.log(`Starting ${mode.toUpperCase()} training with ${lapIds.length} laps`);

      // Set UI to training state
      trainingPanel.setTrainingState(true);

      try {
        // Create or load agent
        if (agentId) {
          await trainingManager.loadAgentProfile(agentId);
        } else if (agentName) {
          await trainingManager.createNewAgent(agentName);
        }

        if (mode === 'bc') {
          // Behavior Cloning - fast imitation learning, no rewards
          const result = await trainingManager.trainAgentFromDemos(
            lapIds,
            agentId ?? undefined,
            (epoch, loss) => {
              trainingPanel.setTrainingProgress(epoch, episodes, loss);
            },
            episodes
          );

          if (result) {
            const profile = trainingManager.getCurrentAgentProfile();
            if (profile) {
              trainingPanel.setSelectedAgent(profile.id);
              timeTrialManager.setCurrentAgentInfo(profile.name);
            }
            console.log(`BC Training complete! Loss: ${result.stats.finalLoss.toFixed(6)}`);
          }
        } else {
          // RL Fine-tuning - uses reward weights
          trainingManager.setRewardWeights(rewardWeights);

          const result = await trainingManager.startRLFineTuning(
            {
              mode: 'quick',
              episodes,
              maxStepsPerEpisode: 2000,
              learningRate: 0.0001,
              discountFactor: 0.99,
              gaeLambda: 0.95,
              rewardWeights,
              bcWarmUpEpochs: 0,
              useDemoReplay: true,
              demoReplayRatio: 0.2,
              // Conservative fine-tuning settings
              fineTuneLearningRate: 0.00001,  // 10x lower for stability
              fineTuneEntropyCoef: 0.001,     // Less exploration
              criticPreTrainEpochs: 20,       // Pre-train value function
            },
            lapIds,
            (progress) => {
              trainingPanel.setTrainingProgress(
                progress.episode,
                progress.totalEpisodes,
                progress.loss ?? 0
              );
            }
          );

          if (result?.success) {
            const profile = trainingManager.getCurrentAgentProfile();
            if (profile) {
              trainingPanel.setSelectedAgent(profile.id);
              timeTrialManager.setCurrentAgentInfo(profile.name);
            }
            console.log(`RL Training complete! Best lap: ${result.bestLapTime?.toFixed(2) ?? 'N/A'}s`);
          }
        }
      } catch (error) {
        console.error('Training failed:', error);
      } finally {
        trainingPanel.setTrainingState(false);
        trainingPanel.refreshData();
      }
    },

    onActivateAgent: async (agentId) => {
      const success = await trainingManager.activateAgentById(agentId);
      if (success) {
        const profile = trainingManager.getCurrentAgentProfile();
        timeTrialManager.setCurrentAgentInfo(profile?.name ?? 'Agent');
        console.log(`Activated agent: ${profile?.name}`);
      }
    },

    onDeleteAgent: async (agentId) => {
      await trainingManager.deleteAgent(agentId);
      trainingPanel.setSelectedAgent(null);
      trainingPanel.refreshData();
      console.log('Agent deleted');
    },

    onDeleteLaps: async (lapIds) => {
      for (const id of lapIds) {
        await lapReplayStorage.deleteReplay(id);
      }
      trainingPanel.refreshData();
      console.log(`Deleted ${lapIds.length} lap(s)`);
    },
  });

  // Set initial track config
  const initialTrackConfig = game.getFullTrackConfig();
  trainingPanel.setCurrentTrack(initialTrackConfig);

  // Hook into replay saved event
  game.setReplaySavedCallback((replay) => {
    trainingPanel.showReplaySaved(replay.lapTime);
  });

  // Set up notification manager and live lap callbacks
  const notifications = getNotificationManager();

  game.setLiveLapCallbacks({
    onSectorComplete: (sectorIndex, sectorTime, delta) => {
      // Show notification for new sector bests
      if (delta < 0) {
        notifications.showSectorBest(sectorIndex + 1, sectorTime);
      }
    },

    onLapComplete: async (lapTime, _sectorTimes, _isNewSessionBest, isAI) => {
      // Check stored personal best to determine if this is a true PB
      const compositeSeed = encodeCompositeSeed(game.getFullTrackConfig());

      if (isAI) {
        // AI lap - check against stored PB for this agent
        const agentName = trainingManager.getCurrentAgentProfile()?.name;
        if (agentName) {
          const storedPB = await lapReplayStorage.getPersonalBest(compositeSeed, '', agentName);
          const isTruePB = !storedPB || lapTime < storedPB.lapTime;
          if (isTruePB) {
            notifications.showNewBest(lapTime, true);
          }
        }
      } else {
        // Human lap - check against stored personal best for current initials
        const currentInitials = timeTrialManager.getStorage().getUserInitials();
        const storedPB = await lapReplayStorage.getPersonalBest(compositeSeed, currentInitials);
        const isTruePB = !storedPB || lapTime < storedPB.lapTime;

        if (isTruePB) {
          notifications.showNewBest(lapTime, false);
        } else if (storedPB) {
          // Check if within 5% of stored best for "fast lap" toast
          const delta = lapTime - storedPB.lapTime;
          const percentDiff = (delta / storedPB.lapTime) * 100;
          if (percentDiff < 5) {
            notifications.showFastLap(lapTime, delta);
          }
        }
      }
    },
  });

  // Integrate training manager with game
  game.setTrainingManager(trainingManager);

  // Sync player initials changes to training panel (for PB badge updates)
  timeTrialManager.setOnInitialsChange((initials) => {
    trainingPanel.setPlayerInitials(initials);
  });

  // ─────────────────────────────────────────────────────────────
  // Self-Imitation Learning (SIL) - Instant Training Mode
  // Auto-start/stop with AI mode, trains immediately on each good lap
  // ─────────────────────────────────────────────────────────────

  // Helper to start SIL session with current agent
  const startSILIfAgentActive = async () => {
    const profile = trainingManager.getCurrentAgentProfile();
    if (!profile) {
      console.log('SIL: No agent loaded, skipping auto-start');
      return;
    }

    // Helper to update SIL UI from session state
    const updateSILUI = () => {
      const session = trainingManager.getSILSession();
      if (session) {
        trainingPanel.updateSILProgress(
          session.sessionLapsCompleted,
          session.sessionGoodLaps,
          session.sessionBestLapTime,
          session.selectedLapCount,
          session.allTimeBestLapTime
        );
      }
    };

    const started = await trainingManager.startSILSession({}, {
      onLapCollected: (lap, score) => {
        console.log(`SIL: Good lap ${lap.lapTime.toFixed(2)}s (score: ${score.overall}) - training...`);
        notifications.showGoodTrainingData(score.overall);
        // Refresh lap list to show new checkbox state
        trainingPanel.refreshData();
        updateSILUI();
      },
      onImprovement: (oldBest, newBest) => {
        console.log(`SIL: Session best improved! ${oldBest.toFixed(2)}s → ${newBest.toFixed(2)}s`);
        notifications.showAgentImprovement(oldBest, newBest);
        updateSILUI();
      },
    });

    if (started) {
      trainingPanel.setSILState(true);
      // Initial UI update to show buffer count
      updateSILUI();
      console.log(`SIL: Instant learning started for agent ${profile.name}`);
    }
  };

  // Stop SIL session
  const stopSIL = () => {
    if (trainingManager.isSILActive()) {
      trainingManager.stopSILSession();
      trainingPanel.setSILState(false);
      console.log('SIL: Stopped');
    }
  };

  // Control mode change: start/stop SIL automatically
  game.setControlModeChangeCallback((isAI) => {
    if (isAI) {
      // AI mode activated - start SIL if agent is loaded
      startSILIfAgentActive();
    } else {
      // Keyboard mode activated - stop SIL
      stopSIL();
    }
  });

  // Feed completed AI laps to SIL (instant training happens in onSILLapComplete)
  game.setAILapCompleteCallback(async (replay) => {
    await trainingManager.onSILLapComplete(replay);
  });

  // Hook into game's track change - stop SIL and update UI
  game.setTrackChangeCallback((config) => {
    // Stop SIL before track change (agent is track-specific)
    stopSIL();

    // Update UI panels
    trainingPanel.setCurrentTrack(config);
    timeTrialManager.clearCurrentAgentInfo();
    timeTrialManager.onTrackChange(); // Update leaderboard

    // Sync tracks panel with current config (seed display + dropdowns)
    tracksPanel.setCurrentTrack(config);
  });

  // Start the game
  game.start();

  // ─────────────────────────────────────────────────────────────
  // Cloud Sync - Background synchronization to Supabase
  // ─────────────────────────────────────────────────────────────

  if (isSupabaseConfigured()) {
    backgroundSync.start();
    console.log('Cloud sync enabled');

    // Listen for sync status changes (optional: update UI)
    backgroundSync.addSyncStatusListener((pending, failed) => {
      if (pending > 0) {
        console.log(`Sync: ${pending} pending, ${failed} failed`);
      }
    });
  } else {
    console.log('Cloud sync disabled (Supabase not configured)');
  }

  // Expose instances for debugging
  const debugWindow = window as unknown as {
    game: Game;
    trainingManager: TrainingManager;
    timeTrialManager: TimeTrialManager;
    trainingPanel: HTMLTrainingPanel;
  };
  debugWindow.game = game;
  debugWindow.trainingManager = trainingManager;
  debugWindow.timeTrialManager = timeTrialManager;
  debugWindow.trainingPanel = trainingPanel;

  console.log('DotGP initialized! Use WASD or arrow keys to move.');
  console.log('Time trial panel on the left - enter a seed to load a specific track.');
  console.log('Training panel on the right - record laps, select them, and train an AI agent.');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
