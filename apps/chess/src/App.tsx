import { useState, useEffect, useRef, useCallback } from "react";
import { Chess, type Move, type Square } from "chess.js";
import { Chessboard } from "react-chessboard";
import { connect, WindowMessenger } from "penpal";

interface AppStateSummary {
  raw: Record<string, unknown>;
  display: string;
}

interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  displayText?: string;
}

interface AppInitConfig {
  sessionId: string;
  theme: "light" | "dark";
  locale: string;
}

interface PlatformMethods {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  [index: string]: PlatformMethods | Function;
  notifyStateUpdate(state: AppStateSummary): Promise<void>;
  signalCompletion(event: string, summary: string): Promise<void>;
  requestResize(height: number): Promise<void>;
}

type Difficulty = "beginner" | "intermediate" | "advanced";

function pickRandomMove(game: Chess): Move | null {
  const moves = game.moves({ verbose: true });
  if (moves.length === 0) return null;
  return moves[Math.floor(Math.random() * moves.length)];
}

function pickIntermediateMove(game: Chess): Move | null {
  const moves = game.moves({ verbose: true });
  if (moves.length === 0) return null;
  const captures = moves.filter((m) => m.captured);
  const checks = moves.filter((m) => m.san.includes("+"));
  const preferred = checks.length > 0 ? checks : captures.length > 0 ? captures : moves;
  return preferred[Math.floor(Math.random() * preferred.length)];
}

function pickAIMove(game: Chess, difficulty: Difficulty): Move | null {
  if (difficulty === "beginner") return pickRandomMove(game);
  if (difficulty === "advanced") return pickIntermediateMove(game);
  return Math.random() > 0.4 ? pickIntermediateMove(game) : pickRandomMove(game);
}

function describePosition(game: Chess): string {
  const history = game.history();
  const moveCount = history.length;
  const turn = game.turn() === "w" ? "White" : "Black";

  if (game.isCheckmate()) {
    const winner = game.turn() === "w" ? "Black" : "White";
    return `Checkmate! ${winner} wins after ${moveCount} moves.`;
  }
  if (game.isStalemate()) return `Stalemate after ${moveCount} moves. Game is a draw.`;
  if (game.isDraw()) return `Draw after ${moveCount} moves.`;
  if (game.isCheck()) return `${turn} is in check. ${moveCount} moves played.`;
  return `${moveCount} moves played. ${turn} to move.`;
}

function countMaterial(fen: string): { white: number; black: number } {
  const values: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  let white = 0;
  let black = 0;
  const board = fen.split(" ")[0];
  for (const ch of board) {
    const lower = ch.toLowerCase();
    if (values[lower]) {
      if (ch === ch.toUpperCase()) white += values[lower];
      else black += values[lower];
    }
  }
  return { white, black };
}

export default function App() {
  const [game, setGame] = useState<Chess | null>(null);
  const [playerColor, setPlayerColor] = useState<"white" | "black">("white");
  const [difficulty, setDifficulty] = useState<Difficulty>("intermediate");
  const [status, setStatus] = useState("Waiting for game to start...");
  const [connectionState, setConnectionState] = useState<"connecting" | "connected" | "error">("connecting");

  const gameRef = useRef<Chess | null>(null);
  const parentRef = useRef<PlatformMethods | null>(null);
  const playerColorRef = useRef<"white" | "black">("white");
  const difficultyRef = useRef<Difficulty>("intermediate");

  const getStateSummary = useCallback((): AppStateSummary => {
    const g = gameRef.current;
    if (!g) {
      return { raw: {}, display: "No game in progress" };
    }
    return {
      raw: {
        fen: g.fen(),
        history: g.history(),
        playerColor: playerColorRef.current,
        isGameOver: g.isGameOver(),
        moveCount: g.history().length,
      },
      display: describePosition(g),
    };
  }, []);

  const notifyParent = useCallback(async () => {
    if (parentRef.current) {
      try {
        await parentRef.current.notifyStateUpdate(getStateSummary());
      } catch {
        /* parent may not be available */
      }
    }
  }, [getStateSummary]);

  const checkGameOver = useCallback(async () => {
    const g = gameRef.current;
    if (!g || !g.isGameOver()) return;

    let event = "game_over";
    let summary = describePosition(g);
    if (g.isCheckmate()) {
      const winner = g.turn() === "w" ? "Black" : "White";
      summary = `Checkmate! ${winner} wins after ${g.history().length} moves.`;
    } else if (g.isStalemate()) {
      event = "draw_agreed";
      summary = `Stalemate. Game drawn after ${g.history().length} moves.`;
    } else if (g.isDraw()) {
      event = "draw_agreed";
      summary = `Draw after ${g.history().length} moves.`;
    }

    setStatus(summary);
    if (parentRef.current) {
      try {
        await parentRef.current.signalCompletion(event, summary);
      } catch {
        /* best effort */
      }
    }
  }, []);

  const makeAIMove = useCallback(
    async (g: Chess) => {
      if (g.isGameOver()) return;
      const aiMove = pickAIMove(g, difficultyRef.current);
      if (aiMove) {
        g.move(aiMove);
        setGame(new Chess(g.fen()));
        gameRef.current = g;
        setStatus(describePosition(g));
        await notifyParent();
        await checkGameOver();
      }
    },
    [notifyParent, checkGameOver],
  );

  const handleStartGame = useCallback(
    (params: Record<string, unknown>): ToolResult => {
      const color = (params.player_color as string) || "white";
      const diff = (params.difficulty as Difficulty) || "intermediate";

      const newGame = new Chess();
      gameRef.current = newGame;
      setGame(newGame);

      const pc = color === "black" ? "black" : "white";
      playerColorRef.current = pc;
      difficultyRef.current = diff;
      setPlayerColor(pc);
      setDifficulty(diff);
      setStatus(`New game started. You are ${pc}. ${pc === "white" ? "Your" : "AI's"} move.`);

      if (pc === "black") {
        setTimeout(() => makeAIMove(newGame), 300);
      }

      return {
        success: true,
        data: { fen: newGame.fen(), playerColor: pc, difficulty: diff },
        displayText: `New chess game started. You are playing as ${pc} against a ${diff} AI opponent. Board is in starting position.${pc === "black" ? " AI is making the first move as white." : " Your move."}`,
      };
    },
    [makeAIMove],
  );

  const handleMakeMove = useCallback(
    async (params: Record<string, unknown>): Promise<ToolResult> => {
      const g = gameRef.current;
      if (!g) {
        return { success: false, error: "No game in progress", displayText: "No chess game is currently in progress. Start a new game first." };
      }

      const moveStr = params.move as string;
      if (!moveStr) {
        return { success: false, error: "No move provided", displayText: "No move was provided. Please specify a move in algebraic notation (e.g., e2e4, Nf3, O-O)." };
      }

      let move: Move;
      try {
        const result = g.move(moveStr);
        if (!result) throw new Error("Invalid move");
        move = result;
      } catch {
        try {
          const from = moveStr.slice(0, 2) as Square;
          const to = moveStr.slice(2, 4) as Square;
          const promotion = moveStr.length > 4 ? moveStr[4] : undefined;
          const result = g.move({ from, to, promotion });
          if (!result) throw new Error("Invalid move");
          move = result;
        } catch {
          const legalMoves = g.moves().join(", ");
          return {
            success: false,
            error: `Invalid move: ${moveStr}`,
            displayText: `"${moveStr}" is not a legal move. Legal moves are: ${legalMoves}`,
          };
        }
      }

      setGame(new Chess(g.fen()));
      gameRef.current = g;
      const moveDesc = `${move.color === "w" ? "White" : "Black"} played ${move.san}.`;
      setStatus(`${moveDesc} ${describePosition(g)}`);

      await notifyParent();

      if (g.isGameOver()) {
        await checkGameOver();
        return {
          success: true,
          data: { fen: g.fen(), move: move.san, gameOver: true },
          displayText: `${moveDesc} ${describePosition(g)}`,
        };
      }

      await makeAIMove(g);

      const aiDesc = describePosition(g);
      const history = g.history();
      const lastAiMove = history.length > 0 ? history[history.length - 1] : "";

      return {
        success: true,
        data: { fen: g.fen(), move: move.san, aiMove: lastAiMove, gameOver: g.isGameOver() },
        displayText: `${moveDesc} AI responded with ${lastAiMove}. ${aiDesc}`,
      };
    },
    [notifyParent, checkGameOver, makeAIMove],
  );

  const handleGetBoardState = useCallback((): ToolResult => {
    const g = gameRef.current;
    if (!g) {
      return { success: false, error: "No game in progress", displayText: "No chess game is currently in progress." };
    }

    const history = g.history();
    const material = countMaterial(g.fen());
    const legalMoves = g.moves();
    const turn = g.turn() === "w" ? "White" : "Black";
    const matDiff = material.white - material.black;
    const matDesc =
      matDiff === 0 ? "Material is equal" : matDiff > 0 ? `White has +${matDiff} material advantage` : `Black has +${Math.abs(matDiff)} material advantage`;

    const displayText = `Position after ${history.length} moves. ${matDesc}. ${turn} to move. ${legalMoves.length} legal moves available: ${legalMoves.slice(0, 10).join(", ")}${legalMoves.length > 10 ? "..." : ""}. ${describePosition(g)}`;

    return {
      success: true,
      data: {
        fen: g.fen(),
        history,
        turn: g.turn(),
        legalMoves,
        isCheck: g.isCheck(),
        isCheckmate: g.isCheckmate(),
        isDraw: g.isDraw(),
        isStalemate: g.isStalemate(),
        isGameOver: g.isGameOver(),
        material,
      },
      displayText,
    };
  }, []);

  const handleAnalyzePosition = useCallback((): ToolResult => {
    const g = gameRef.current;
    if (!g) {
      return { success: false, error: "No game in progress", displayText: "No chess game is currently in progress." };
    }

    const moves = g.moves({ verbose: true });
    const material = countMaterial(g.fen());
    const matDiff = material.white - material.black;

    const scored = moves.map((m) => {
      let score = 0;
      if (m.captured) {
        const capValues: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
        score += (capValues[m.captured] || 0) * 10;
      }
      if (m.san.includes("+")) score += 5;
      if (m.san.includes("#")) score += 100;
      const center = ["d4", "d5", "e4", "e5"];
      if (center.includes(m.to)) score += 2;
      if (m.piece === "n" || m.piece === "b") score += 1;
      if (m.san === "O-O" || m.san === "O-O-O") score += 3;
      return { move: m.san, score, reason: describeMove(m) };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 5);

    const evalDesc =
      matDiff === 0 ? "roughly equal" : matDiff > 0 ? `White is ahead by ${matDiff} points` : `Black is ahead by ${Math.abs(matDiff)} points`;

    const suggestions = top.map((m, i) => `${i + 1}) ${m.move} (${m.reason})`).join(" ");
    const displayText = `Position evaluation: ${evalDesc}. Suggested moves: ${suggestions}`;

    return {
      success: true,
      data: { evaluation: evalDesc, topMoves: top, material },
      displayText,
    };
  }, []);

  const handleStartGameRef = useRef(handleStartGame);
  const handleMakeMoveRef = useRef(handleMakeMove);
  const handleGetBoardStateRef = useRef(handleGetBoardState);
  const handleAnalyzePositionRef = useRef(handleAnalyzePosition);
  const getStateSummaryRef = useRef(getStateSummary);
  handleStartGameRef.current = handleStartGame;
  handleMakeMoveRef.current = handleMakeMove;
  handleGetBoardStateRef.current = handleGetBoardState;
  handleAnalyzePositionRef.current = handleAnalyzePosition;
  getStateSummaryRef.current = getStateSummary;

  useEffect(() => {
    const messenger = new WindowMessenger({
      remoteWindow: window.parent,
      allowedOrigins: ["*"],
    });

    const connection = connect<PlatformMethods>({
      messenger,
      methods: {
        async initialize(config: AppInitConfig) {
          console.log("[Chess] initialize:", config);
        },
        async invokeTool(
          toolName: string,
          params: Record<string, unknown>,
        ): Promise<ToolResult> {
          console.log("[Chess] invokeTool:", toolName, params);
          switch (toolName) {
            case "start_game":
              return handleStartGameRef.current(params);
            case "make_move":
              return handleMakeMoveRef.current(params);
            case "get_board_state":
              return handleGetBoardStateRef.current();
            case "analyze_position":
              return handleAnalyzePositionRef.current();
            default:
              return { success: false, error: `Unknown tool: ${toolName}`, displayText: `Unknown tool "${toolName}".` };
          }
        },
        async getState(): Promise<AppStateSummary> {
          return getStateSummaryRef.current();
        },
        async destroy() {
          console.log("[Chess] destroy");
        },
      },
      timeout: 5000,
    });

    connection.promise
      .then(async (parent) => {
        parentRef.current = parent;
        setConnectionState("connected");
        await parent.notifyStateUpdate(getStateSummaryRef.current());
      })
      .catch((err) => {
        console.error("[Chess] Penpal connection failed:", err);
        setConnectionState("error");
      });

    return () => {
      connection.destroy();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { piece: unknown; sourceSquare: string; targetSquare: string | null }): boolean => {
      const g = gameRef.current;
      if (!g || g.isGameOver() || !targetSquare) return false;

      const turn = g.turn();
      if ((turn === "w" && playerColorRef.current === "black") || (turn === "b" && playerColorRef.current === "white")) {
        return false;
      }

      try {
        g.move({ from: sourceSquare as Square, to: targetSquare as Square, promotion: "q" });
      } catch {
        return false;
      }

      setGame(new Chess(g.fen()));
      gameRef.current = g;
      setStatus(describePosition(g));
      notifyParent();

      if (g.isGameOver()) {
        checkGameOver();
        return true;
      }

      setTimeout(() => makeAIMove(g), 300);
      return true;
    },
    [notifyParent, checkGameOver, makeAIMove],
  );

  return (
    <div className="flex min-h-screen flex-col items-center bg-gray-900 p-3">
      <div className="mb-2 w-full max-w-[320px]">
        <h1 className="text-center text-base font-semibold text-gray-100">Chess</h1>
        <p className="text-center text-xs text-gray-400">{status}</p>
      </div>

      {connectionState === "connecting" && (
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-600 border-t-blue-500" />
          Connecting...
        </div>
      )}

      {connectionState === "error" && (
        <div className="text-sm text-red-400">Failed to connect to platform.</div>
      )}

      <div className="w-full max-w-[320px]">
        {game ? (
          <Chessboard
            options={{
              position: game.fen(),
              boardOrientation: playerColor,
              onPieceDrop,
              allowDragging: !game.isGameOver(),
              animationDurationInMs: 200,
              darkSquareStyle: { backgroundColor: "#4a5568" },
              lightSquareStyle: { backgroundColor: "#a0aec0" },
            }}
          />
        ) : (
          <div className="flex aspect-square items-center justify-center rounded border border-gray-700 bg-gray-800 text-sm text-gray-500">
            Ask the chatbot to start a chess game
          </div>
        )}
      </div>

      {game && (
        <div className="mt-2 w-full max-w-[320px]">
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>Playing as {playerColor}</span>
            <span>Difficulty: {difficulty}</span>
          </div>
          {game.history().length > 0 && (
            <div className="mt-1 max-h-20 overflow-y-auto rounded bg-gray-800 p-2 text-xs text-gray-400">
              {formatMoveHistory(game.history())}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function describeMove(m: Move): string {
  if (m.san === "O-O" || m.san === "O-O-O") return "castling";
  if (m.san.includes("#")) return "checkmate";
  if (m.san.includes("+")) return "check";
  if (m.captured) return `captures ${m.captured}`;
  const center = ["d4", "d5", "e4", "e5"];
  if (center.includes(m.to)) return "controls center";
  if (m.piece === "n" || m.piece === "b") return "develops piece";
  return "positional";
}

function formatMoveHistory(history: string[]): string {
  const pairs: string[] = [];
  for (let i = 0; i < history.length; i += 2) {
    const num = Math.floor(i / 2) + 1;
    const white = history[i];
    const black = history[i + 1] ?? "";
    pairs.push(`${num}. ${white} ${black}`);
  }
  return pairs.join("  ");
}
