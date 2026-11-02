import Link from "next/link";

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  basePath: string;
  query: Record<string, string>;
}

/** Navigasi halaman berbasis URL agar filter tetap terbawa dan bisa di-bookmark. */
export function Pagination({ page, pageSize, total, basePath, query }: PaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const hrefFor = (target: number) => {
    const params = new URLSearchParams(query);
    if (target > 1) params.set("page", String(target));
    else params.delete("page");
    const serialized = params.toString();
    return serialized ? `${basePath}?${serialized}` : basePath;
  };

  const firstItem = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastItem = Math.min(page * pageSize, total);

  return (
    <div className="pager">
      <span>
        Menampilkan {firstItem}–{lastItem} dari {total}
      </span>
      <div className="pager__links">
        <Link
          className={page <= 1 ? "pager__link pager__link--disabled" : "pager__link"}
          href={hrefFor(Math.max(1, page - 1))}
          aria-disabled={page <= 1}
        >
          Sebelumnya
        </Link>
        <span className="pager__link pager__link--disabled" aria-hidden="true">
          {page} / {pageCount}
        </span>
        <Link
          className={page >= pageCount ? "pager__link pager__link--disabled" : "pager__link"}
          href={hrefFor(Math.min(pageCount, page + 1))}
          aria-disabled={page >= pageCount}
        >
          Berikutnya
        </Link>
      </div>
    </div>
  );
}
