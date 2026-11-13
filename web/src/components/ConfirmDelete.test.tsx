import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDelete } from "./ConfirmDelete";

describe("ConfirmDelete", () => {
  it("asks before deleting and says files are removed", async () => {
    const onConfirm = vi.fn(async () => {});
    render(<ConfirmDelete what="“Sintel”" onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete “Sintel” and its files from disk?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("shows the error and lets you retry", async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error("torrent not found");
    });
    render(<ConfirmDelete what="x" onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("torrent not found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });
});

describe("ConfirmDelete keyboard", () => {
  it("Escape cancels and focus returns to Delete", async () => {
    render(<ConfirmDelete what="x" onConfirm={vi.fn(async () => {})} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.keyboard("{Escape}");
    const del = screen.getByRole("button", { name: "Delete" });
    expect(del).toHaveFocus();
    expect(screen.queryByText(/from disk/)).not.toBeInTheDocument();
  });
});
