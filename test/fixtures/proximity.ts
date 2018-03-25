import { Machine } from '../../src/StateNode';

export const machine = Machine({
  initial: 'A',
  states: {
    A: {
      initial: 'foo',
      states: {
        foo: {
          on: {
            NEXT: 'bar'
          }
        },
        bar: {
          on: {
            NEXT: 'B.foo'
          }
        }
      }
    },
    B: {
      initial: 'foo',
      states: {
        foo: {
          on: {
            NEXT: 'bar'
          }
        },
        bar: {
          on: {
            NEXT: 'A.foo'
          }
        }
      }
    }
  }
});

export const bigMachine = Machine({
  initial: 'A',
  states: {
    A: {
      initial: 'one',
      states: {
        one: {
          on: {
            NEXT: 'two'
          }
        }
      }
    },
    B: {
      initial: 'two',
      states: {
        two: {
          on: {
            NEXT: 'three'
          }
        },
        foo: {
          states: {
            three: {
              on: { NEXT: 'four' }
            }
          }
        },
        four: {
          on: {
            NEXT: 'one'
          }
        }
      }
    }
  }
});
