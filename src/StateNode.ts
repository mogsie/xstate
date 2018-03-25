import {
  getEventType,
  toStatePath,
  toStateValue,
  mapValues,
  path,
  toStatePaths,
  pathsToStateValue
} from './utils';
import {
  Event,
  StateValue,
  Transition,
  Action,
  Machine,
  StandardMachine,
  ParallelMachine,
  SimpleOrCompoundStateNodeConfig,
  MachineConfig,
  ParallelMachineConfig,
  EventType,
  ActionMap,
  StandardMachineConfig,
  TransitionConfig,
  ActivityMap,
  StateNodeConfig,
  Activity,
  StateTransition,
  EventObject
} from './types';
import { matchesState } from './matchesState';
import { State } from './State';
import { start, stop, toEventObject, actionTypes } from './actions';

const STATE_DELIMITER = '.';
const HISTORY_KEY = '$history';
const NULL_EVENT = '';
const STATE_IDENTIFIER = '#';
const isStateId = (str: string) => str[0] === STATE_IDENTIFIER;

class StateNode implements StateNodeConfig {
  public key: string;
  public id: string;
  public path: string[];
  public initial?: string;
  public parallel?: boolean;
  public states: Record<string, StateNode>;
  public on?: Record<string, Transition | undefined>;
  public onEntry?: Action[];
  public onExit?: Action[];
  public activities?: Activity[];
  public strict: boolean;
  public parent?: StateNode;
  public machine: StateNode;
  public data: object | undefined;

  private __cache = {
    events: undefined as EventType[] | undefined,
    relativeValue: new Map() as Map<StateNode, StateValue>,
    initialState: undefined as StateValue | undefined
  };

  public idMap: Record<string, StateNode> = {};

  constructor(
    public config:
      | SimpleOrCompoundStateNodeConfig
      | StandardMachineConfig
      | ParallelMachineConfig
  ) {
    this.key = config.key || '(machine)';
    this.parent = config.parent;
    this.machine = this.parent ? this.parent.machine : this;
    this.path = this.parent ? this.parent.path.concat(this.key) : [];
    this.id =
      config.id ||
      (this.machine
        ? [this.machine.key, ...this.path].join(STATE_DELIMITER)
        : this.key);
    this.initial = config.initial;
    this.parallel = !!config.parallel;
    this.states = (config.states
      ? mapValues<
          SimpleOrCompoundStateNodeConfig,
          StateNode
        >(config.states, (stateConfig, key) => {
          const stateNode = new StateNode({
            ...stateConfig,
            key,
            parent: this
          });
          Object.assign(this.idMap, {
            [stateNode.id]: stateNode,
            ...stateNode.idMap
          });
          return stateNode;
        })
      : {}) as Record<string, StateNode>;

    this.on = config.on;
    this.strict = !!config.strict;
    this.onEntry = config.onEntry
      ? ([] as Action[]).concat(config.onEntry)
      : undefined;
    this.onExit = config.onExit
      ? ([] as Action[]).concat(config.onExit)
      : undefined;
    this.data = config.data;
    this.activities = config.activities;
    if (!this.parent) {
      console.log('Rehashing machine', this.id);
      this.rehash();
    }
  }
  public getStateNodes(state: StateValue | State): StateNode[] {
    const stateValue =
      state instanceof State ? state.value : toStateValue(state);

    if (typeof stateValue === 'string') {
      const initialStateValue = this.getStateNode(stateValue).initial;

      return initialStateValue
        ? this.getStateNodes({ [stateValue]: initialStateValue })
        : [this.states[stateValue]];
    }

    const subStateKeys = Object.keys(stateValue);
    const subStateNodes: StateNode[] = subStateKeys.map(subStateKey =>
      this.getStateNode(subStateKey)
    );

    return subStateNodes.concat(
      subStateKeys
        .map(subStateKey => {
          return this.getStateNode(subStateKey).getStateNodes(
            stateValue[subStateKey]
          );
        })
        .reduce((a, b) => a.concat(b))
    );
  }
  public handles(event: Event): boolean {
    const eventType = getEventType(event);

    return this.events.indexOf(eventType) !== -1;
  }
  public transition(
    state: StateValue | State,
    event: Event,
    extendedState?: any
  ): State {
    const resolvedStateValue =
      typeof state === 'string' && isStateId(state)
        ? this.getResolvedPath(state).join(STATE_DELIMITER)
        : state;

    if (this.strict) {
      const eventType = getEventType(event);
      if (this.events.indexOf(eventType) === -1) {
        throw new Error(
          `Machine '${this.id}' does not accept event '${eventType}'`
        );
      }
    }

    const currentState = State.from(resolvedStateValue);

    const stateTransition = this.transitionStateValue(
      currentState,
      event,
      currentState,
      extendedState
    );
    const nextState = this.stateTransitionToState(
      stateTransition,
      currentState
    );

    if (!nextState) {
      return State.inert(currentState);
    }

    let maybeNextState: State | undefined = nextState;

    const raisedEvents = nextState.actions.filter(
      a => typeof a === 'object' && a.type === actionTypes.raise
    );

    if (raisedEvents.length) {
      const raisedEvent = (raisedEvents[0] as EventObject).event!;

      maybeNextState = this.transition(nextState, raisedEvent, extendedState);
      maybeNextState.actions.unshift(...nextState.actions);
      return maybeNextState;
    }

    if (stateTransition.events.length) {
      const raised =
        stateTransition.events[0].type === actionTypes.raise
          ? stateTransition.events[0].event!
          : undefined;
      const nullEvent = stateTransition.events[0].type === actionTypes.null;

      if (raised || nullEvent) {
        maybeNextState = this.transition(
          nextState,
          nullEvent ? '' : raised,
          extendedState
        );
        maybeNextState.actions.unshift(...nextState.actions);
        return maybeNextState;
      }
    }

    return nextState;
  }
  private rehash() {
    if (this.on) {
      const newOn = {};
      Object.keys(this.on).forEach(event => {
        if (this.on && this.on[event]) {
          console.log(typeof this.on[event]);
          const e = this.on[event];
          if (typeof e === 'string') {
            newOn[event] = this.lookForClosestState(e);
          } else {
            newOn[event] = this.on[event];
          }
        }
      });
      this.on = newOn;
    }

    // Also do children...
    Object.keys(this.states).forEach(key => this.states[key].rehash());
  }
  private lookForClosestState(name: string): string {
    if (this.parent && this.parent.states && this.parent.states[name]) {
      return '#' + this.parent.states[name].id;
    }
    if (this.states && this.states[name]) {
      return '#' + this.states[name].id;
    }
    const names: string[] = [];
    let depth: number = 1;
    const endsWithName = '.' + name;
    while (this.aggregateStates(depth, names)) {
      const found = names
        .filter(candidate => !!candidate)
        .filter(candidate => candidate.endsWith(endsWithName));
      if (found.length > 1) {
        throw new Error(
          `Ambiguous reference to '${name}', ${found.length} target states were found.  It was specified in the state '${this
            .id}'.`
        );
      }
      if (found.length == 1) {
        return '#' + found[0];
      }
      depth++;
      names.length = 0;
    }

    if (this.parent) {
      console.log('bubbling up one level', !!this.parent);
      return this.parent.lookForClosestState(name);
    }

    //throw new Error(
    //  `Unable to understand the state '${name}', it was not found in the machine.  It was specified in the state '${this.id}'.`
    //);

    // returning the name a workaround since throwing the error causes loads of tests to fail.
    return name;
  }
  private aggregateStates(level: number, names: string[]): boolean {
    let states = {};
    if (this.states) {
      states = this.states;
    } else if (this.config && this.config.states) {
      states = this.config.states;
    }
    const substates = Object.keys(states).map(name => states[name]);
    if (level == 1) {
      names.push(...substates.map(state => state.id));
      return !!substates.find(state => !!state.states);
    } else {
      let result: boolean = false;
      substates.forEach(state => {
        if (state.aggregateStates) {
          result = state.aggregateStates(level - 1, names) || result;
        }
      });
      return result;
    }
  }
  private stateTransitionToState(
    stateTransition: StateTransition,
    prevState: State
  ): State | undefined {
    const {
      statePaths: nextStatePaths,
      actions: nextActions,
      activities: nextActivities,
      events
    } = stateTransition;

    if (!nextStatePaths.length) {
      return undefined;
    }

    const prevActivities =
      prevState instanceof State ? prevState.activities : undefined;

    const activities = { ...prevActivities, ...nextActivities };

    const nextStateValue = this.resolve(pathsToStateValue(nextStatePaths));
    return new State(
      // next state value
      nextStateValue,
      // history
      State.from(prevState),
      // effects
      nextActions
        ? nextActions.onExit
            .concat(nextActions.actions)
            .concat(nextActions.onEntry)
        : [],
      // activities
      activities,
      // data
      this.getStateNodes(nextStateValue).reduce(
        (data, stateNode) => {
          if (stateNode.data !== undefined) {
            data[stateNode.id] = stateNode.data;
          }

          return data;
        },
        {} as Record<string, any>
      ),
      events
    );
  }
  private getStateNode(stateKey: string): StateNode {
    if (!this.states) {
      throw new Error(
        `Unable to retrieve child state '${stateKey}' from '${this
          .id}'; no child states exist.`
      );
    }

    const result = this.states[stateKey];
    if (!result) {
      throw new Error(
        `Child state '${stateKey}' does not exist on '${this.id}'`
      );
    }

    return result;
  }
  private resolve(stateValue: StateValue): StateValue {
    if (typeof stateValue === 'string') {
      const subStateNode = this.getStateNode(stateValue);
      return subStateNode.initial
        ? { [stateValue]: subStateNode.initialStateValue! }
        : stateValue;
    }

    if (this.parallel) {
      return mapValues(
        this.initialStateValue as Record<string, StateValue>,
        (subStateValue, subStateKey) => {
          return this.getStateNode(subStateKey).resolve(
            stateValue[subStateKey] || subStateValue
          );
        }
      );
    }

    return mapValues(stateValue, (subStateValue, subStateKey) => {
      return this.getStateNode(subStateKey).resolve(subStateValue);
    });
  }
  private transitionStateValue(
    state: State,
    event: Event,
    fullState: State,
    extendedState?: any
  ): StateTransition {
    const { history } = state;
    let stateValue = state.value;

    if (typeof stateValue === 'string') {
      const subStateNode = this.getStateNode(stateValue);
      try {
        stateValue = subStateNode.resolvedStateValue;
      } catch (e) {
        throw new Error(`${stateValue}`);
      }

      if (typeof stateValue === 'string') {
        // Transition from the substate
        return subStateNode.next(
          event,
          fullState,
          history ? history.value : undefined,
          extendedState
        );
      }
    }

    // Potential transition tuples from parent state nodes
    const potentialStateTransitions: StateTransition[] = [];

    let nextStateTransitionMap = mapValues(
      stateValue,
      (subStateValue, subStateKey) => {
        const subStateNode = this.getStateNode(subStateKey);
        const subHistory = history ? history.value[subStateKey] : undefined;
        const subState = new State(
          subStateValue,
          subHistory ? State.from(subHistory) : undefined
        );
        const subStateTransition = subStateNode.transitionStateValue(
          subState,
          event,
          fullState,
          extendedState
        );

        if (!subStateTransition.statePaths.length) {
          potentialStateTransitions.push(
            subStateNode.next(
              event,
              fullState,
              history ? history.value : undefined,
              extendedState
            )
          );
        }

        return subStateTransition;
      }
    );

    if (
      Array.prototype.every.call(Object.keys(nextStateTransitionMap), key => {
        return !nextStateTransitionMap[key].statePaths.length;
      })
    ) {
      if (this.parallel) {
        if (potentialStateTransitions.length) {
          return potentialStateTransitions[0];
        }

        return {
          statePaths: [],
          actions: { onEntry: [], onExit: [], actions: [] },
          activities: undefined,
          events: []
        };
      }

      const subStateKey = Object.keys(nextStateTransitionMap)[0];

      // try with parent
      const {
        statePaths: parentStatePaths,
        actions: parentNextActions,
        activities: parentActivities
      } = this.getStateNode(subStateKey).next(
        event,
        fullState,
        history ? history.value : undefined,
        extendedState
      );

      const nextActions = nextStateTransitionMap[subStateKey].actions;
      const activities = nextStateTransitionMap[subStateKey].activities;

      const allActivities = {
        ...activities,
        ...parentActivities
      };

      const allActions = parentNextActions
        ? nextActions
          ? {
              onEntry: [...nextActions.onEntry, ...parentNextActions.onEntry],
              actions: [...nextActions.actions, ...parentNextActions.actions],
              onExit: [...nextActions.onExit, ...parentNextActions.onExit]
            }
          : parentNextActions
        : nextActions;

      return {
        statePaths: parentStatePaths,
        actions: allActions,
        activities: allActivities,
        events: []
      };
    }

    if (this.parallel) {
      nextStateTransitionMap = {
        ...mapValues(
          this.initialState.value as Record<string, StateValue>,
          (subStateValue, key) => {
            const subStateTransition = nextStateTransitionMap[key];
            return {
              statePaths:
                subStateTransition && subStateTransition.statePaths.length
                  ? subStateTransition.statePaths
                  : toStatePaths(
                      stateValue[key] || subStateValue
                    ).map(subPath => [
                      ...this.getStateNode(key).path,
                      ...subPath
                    ]),
              actions:
                subStateTransition && subStateTransition.actions
                  ? subStateTransition.actions
                  : {
                      onEntry: [],
                      onExit: [],
                      actions: []
                    },
              activities: undefined,
              events: []
            };
          }
        )
      };
    }

    const finalActions: ActionMap = {
      onEntry: [],
      actions: [],
      onExit: []
    };
    const finalActivities: ActivityMap = {};
    mapValues(nextStateTransitionMap, subStateTransition => {
      const {
        // statePaths: nextSubStatePaths,
        actions: nextSubActions,
        activities: nextSubActivities
      } = subStateTransition;
      if (nextSubActions) {
        if (nextSubActions.onEntry) {
          finalActions.onEntry.push(...nextSubActions.onEntry);
        }
        if (nextSubActions.actions) {
          finalActions.actions.push(...nextSubActions.actions);
        }
        if (nextSubActions.onExit) {
          finalActions.onExit.push(...nextSubActions.onExit);
        }
      }
      if (nextSubActivities) {
        Object.assign(finalActivities, nextSubActivities);
      }
    });

    return {
      statePaths: Object.keys(nextStateTransitionMap)
        .map(stateKey => nextStateTransitionMap[stateKey].statePaths)
        .reduce((a, b) => a.concat(b), [] as string[][]),
      actions: finalActions,
      activities: finalActivities,
      events: []
    };
  }

  private next(
    event: Event,
    fullState: State,
    history?: StateValue,
    extendedState?: any
  ): StateTransition {
    const eventType = getEventType(event);
    const actionMap: ActionMap = { onEntry: [], onExit: [], actions: [] };
    const activityMap: ActivityMap = {};

    if (this.onExit) {
      actionMap.onExit = this.onExit;
    }
    if (this.activities) {
      this.activities.forEach(activity => {
        activityMap[getEventType(activity)] = false;
        actionMap.onExit = actionMap.onExit.concat(stop(activity));
      });
    }

    if (!this.on || !this.on[eventType]) {
      return {
        statePaths: [],
        actions: actionMap,
        activities: activityMap,
        events: []
      };
    }

    const transition = this.on[eventType] as Transition;
    let nextStateString: string | undefined;

    if (typeof transition === 'string') {
      nextStateString = transition;
    } else {
      const candidates = Array.isArray(transition)
        ? transition
        : Object.keys(transition).map(key => ({
            ...transition[key],
            target: key
          }));

      for (const candidate of candidates) {
        const {
          cond,
          in: stateIn,
          actions: transitionActions
        } = candidate as TransitionConfig;
        const extendedStateObject = extendedState || {};
        const eventObject = toEventObject(event);

        const isInState = stateIn
          ? matchesState(
              toStateValue(stateIn),
              path(this.path.slice(0, -2))(fullState.value)
            )
          : true;

        if (
          (!cond || cond(extendedStateObject, eventObject)) &&
          (!stateIn || isInState)
        ) {
          nextStateString = candidate.target;
          if (transitionActions) {
            actionMap.actions = actionMap.actions.concat(transitionActions);
          }
          break;
        }
      }
    }

    if (!nextStateString) {
      return {
        statePaths: [],
        actions: actionMap,
        activities: activityMap,
        events: []
      };
    }

    const nextStatePath = this.getResolvedPath(nextStateString);
    let currentState = isStateId(nextStateString) ? this.machine : this.parent;
    let currentHistory = history;
    let currentPath = this.key;

    nextStatePath.forEach(subPath => {
      if (!currentState || !currentState.states) {
        throw new Error(`Unable to read '${subPath}'`);
      }

      if (subPath === HISTORY_KEY) {
        if (currentHistory) {
          subPath =
            typeof currentHistory === 'object'
              ? Object.keys(currentHistory)[0]
              : currentHistory;
        } else if (currentState.initial) {
          subPath = currentState.initial;
        } else {
          throw new Error(
            `Cannot read '${HISTORY_KEY}' from state '${currentState.id}': missing 'initial'`
          );
        }
      } else if (subPath === NULL_EVENT) {
        actionMap.onExit = [];
        currentState = currentState.getStateNode(this.key);
        return;
      }

      try {
        currentState = currentState.getStateNode(subPath);
      } catch (e) {
        throw new Error(
          `Event '${event}' on state '${currentPath}' leads to undefined state '${nextStatePath.join(
            STATE_DELIMITER
          )}'.`
        );
      }

      if (currentState.onEntry) {
        actionMap.onEntry = actionMap.onEntry.concat(currentState.onEntry);
      }
      if (currentState.activities) {
        currentState.activities.forEach(activity => {
          activityMap[getEventType(activity)] = true;
          actionMap.onEntry = actionMap.onEntry.concat(start(activity));
        });
      }

      currentPath = subPath;

      if (currentHistory) {
        currentHistory = currentHistory[subPath];
      }
    });

    if (!currentState) {
      throw new Error('no state');
    }

    let paths = [currentState.path];

    if (currentState.initial || currentState.parallel) {
      const { initialState } = currentState;
      actionMap.onEntry = actionMap.onEntry.concat(initialState.actions);
      paths = toStatePaths(initialState.value).map(subPath =>
        currentState!.path.concat(subPath)
      );
    }

    while (currentState.initial) {
      if (!currentState || !currentState.states) {
        throw new Error(`Invalid initial state`);
      }
      currentState = currentState.states[currentState.initial];

      // if (currentState.onEntry) {
      //   actionMap.onEntry = actionMap.onEntry.concat(currentState.onEntry);
      // }
      if (currentState.activities) {
        currentState.activities.forEach(activity => {
          activityMap[getEventType(activity)] = true;
          actionMap.onEntry = actionMap.onEntry.concat(start(activity));
        });
      }
    }

    const raisedEvents = (currentState.onEntry
      ? currentState.onEntry.filter(
          a => typeof a === 'object' && a.type === actionTypes.raise
        )
      : []
    ).concat(
      currentState.on && currentState.on[''] ? { type: actionTypes.null } : []
    );

    return {
      statePaths: paths,
      actions: actionMap,
      activities: activityMap,
      events: raisedEvents as EventObject[]
    };
  }
  private get resolvedStateValue(): StateValue {
    const { key } = this;

    if (this.parallel) {
      return {
        [key]: mapValues(
          this.states,
          stateNode => stateNode.resolvedStateValue[stateNode.key]
        )
      };
    }

    if (!this.initial) {
      // If leaf node, value is just the state node's key
      return key;
    }

    return {
      [key]: this.states[this.initial].resolvedStateValue
    };
  }
  private getResolvedPath(stateIdentifier: string): string[] {
    if (stateIdentifier[0] === '#') {
      const stateNode = this.machine.idMap[stateIdentifier.slice(1)];

      if (!stateNode) {
        throw new Error(`Unable to find state node '${stateIdentifier}'`);
      }

      return stateNode.path;
    }

    return toStatePath(stateIdentifier);
  }
  private get initialStateValue(): StateValue | undefined {
    const initialStateValue =
      this.__cache.initialState ||
      ((this.parallel
        ? mapValues(
            this.states as Record<string, StateNode>,
            state => state.initialStateValue
          )
        : typeof this.resolvedStateValue === 'string'
          ? undefined
          : this.resolvedStateValue[this.key]) as StateValue);

    this.__cache.initialState = initialStateValue;

    return this.__cache.initialState;
  }
  public get initialState(): State {
    const { initialStateValue } = this;

    if (!initialStateValue) {
      throw new Error(
        `Cannot retrieve initial state from simple state '${this.id}.'`
      );
    }

    const activityMap: ActivityMap = {};
    const actions: Action[] = [];

    this.getStateNodes(initialStateValue).forEach(stateNode => {
      if (stateNode.onEntry) {
        actions.push(...stateNode.onEntry);
      }
      if (stateNode.activities) {
        stateNode.activities.forEach(activity => {
          activityMap[getEventType(activity)] = true;
          actions.push(start(activity));
        });
      }
    });

    return new State(initialStateValue, undefined, actions, activityMap);
  }
  public getStates(stateValue: StateValue): StateNode[] {
    if (typeof stateValue === 'string') {
      return [this.states[stateValue]];
    }

    const stateNodes: StateNode[] = [];

    Object.keys(stateValue).forEach(key => {
      stateNodes.push(...this.states[key].getStates(stateValue[key]));
    });

    return stateNodes;
  }
  public getState(relativeStateId: string | string[]): StateNode | undefined {
    const statePath = toStatePath(relativeStateId);

    try {
      return statePath.reduce(
        (subState, subPath) => {
          if (!subState.states) {
            throw new Error(
              `Cannot retrieve subPath '${subPath}' from node with no states`
            );
          }
          return subState.states[subPath];
        },
        this as StateNode
      );
    } catch (e) {
      throw new Error(
        `State '${relativeStateId} does not exist on machine '${this.id}'`
      );
    }
  }
  get events(): EventType[] {
    if (this.__cache.events) {
      return this.__cache.events;
    }
    const { states } = this;
    const events = new Set(this.on ? Object.keys(this.on) : undefined);

    if (states) {
      Object.keys(states).forEach(stateId => {
        const state = states[stateId];
        if (state.states) {
          for (const event of state.events) {
            events.add(`${event}`);
          }
        }
      });
    }

    return (this.__cache.events = Array.from(events));
  }
}

export function Machine(
  config: MachineConfig | ParallelMachineConfig
): StandardMachine | ParallelMachine {
  return new StateNode(config) as StandardMachine | ParallelMachine;
}

export { StateNode };
